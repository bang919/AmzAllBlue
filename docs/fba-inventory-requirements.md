# FBA 库存功能需求

## 目标

FBA 库存模块用于监控美国站库存、销量、发货和补货节奏。核心目标不是做财务库存，而是帮助判断：

- 当前可售库存还能卖多久
- 是否需要从工厂/国内仓继续发货
- 是否需要继续补货生产
- Amazon 各库存状态是否有异常积压

## 市场和日期

- 当前按美国市场设计。
- 业务日期按美国站日期处理，不按本机北京时间切分。
- 销量数据按单日请求、单日记录。
- 当天库存优先使用 FBA Inventory API 当前快照。
- 旧日期库存优先使用 Amazon FBA Ledger Summary 报表回填仓内库存。该报表可按日返回 `SELLABLE` 和其他 disposition 的期末仓库余额，因此旧日期“可售”和“不可售”可以使用；但它不提供“入库计划、已发货、接收中、预留”等当前库存快照里的细分在途状态。
- 页面上旧日期缺失的库存字段用 `/` 显示，不用 0 显示，避免把“查不到”误解为“确实为 0”。旧日期的 `总货量` 也用 `/` 显示，因为运营定义的总货量包含在途和预留分项，Ledger 只能证明仓内余额。
- 如果 Ledger 报表不可用，历史库存才退回为“只能从系统开始每天同步后逐日积累”，不能用今天库存回填过去日期。

## 存储选型

第一阶段采用本机 MySQL。库存/销量按每日事实表保存；ASIN、品名、图片等相对稳定的商品资料单独保存，避免清理历史库存快照时丢失历史销量行的展示信息。

- 服务通过 `.env` 中的 `DB_*` 配置连接 MySQL。
- 如果 `DB_ENABLED` 未开启，服务保留 JSON 文件回退，便于开发时临时启动；正式 FBA 库存记录应使用 MySQL。
- 服务启动后首次访问 FBA 数据时会自动创建数据库和表。
- Navicat 可用于查看本机 MySQL，但 Google Sheets 不作为主数据库，只适合做导出、分享或报表。

MySQL 表名：

```text
fba_inventory_daily
fba_sku_metadata
```

唯一键：

```text
marketplace_id + seller_sku + date
```

## 每日事实表字段

`fba_inventory_daily` 每一行代表某个美国站 SKU 在某一天的库存和销量记录。

```text
date
marketplace_id
seller_sku
asin
fn_sku
title
brand
image_url

amazon_total_quantity
total_goods_quantity
fulfillable_quantity
reserved_quantity
unfulfillable_quantity
inbound_working_quantity
inbound_shipped_quantity
inbound_receiving_quantity

sales_units
sales_orders
is_sufficient

inventory_fetched_at
sales_fetched_at
frozen_at
raw_inventory_json
raw_sales_json
```

## SKU 商品资料表字段

`fba_sku_metadata` 用来维护 SKU 维度的稳定商品资料。它不表示某天库存，只用于历史销量行补全 ASIN、FNSKU、品名、品牌、图片等信息。

```text
marketplace_id
seller_sku
asin
fn_sku
title
brand
image_url
item_condition
source
last_seen_at
raw_json
```

唯一键：

```text
marketplace_id + seller_sku
```

## 库存字段定义

当天字段直接来自 Amazon SP-API FBA Inventory summaries；旧日期仓内库存来自 FBA Ledger Summary 报表。两者都避免使用旧项目里的减法倒推。

- `fulfillable_quantity`：可售库存，已经在 Amazon 仓内并可配送。
- `reserved_quantity`：预留库存，通常被订单、调拨或 Amazon 内部处理占用，暂时不可售。
- `unfulfillable_quantity`：不可售库存。
- `inbound_working_quantity`：入库计划中。通常表示已创建 FBA shipment，但未确认进入运输或接收状态；货还在中国、货代未发出时可能在这里。
- `inbound_shipped_quantity`：已发货给 Amazon，但 Amazon 未开始接收。海运、空运、卡车途中，靠岸但未提取时通常仍可理解为这个状态。
- `inbound_receiving_quantity`：Amazon 已开始接收、扫描、分拣或上架，但还未转为可售。

旧日期 Ledger 映射：

```text
SELLABLE ending warehouse balance -> fulfillable_quantity
非 SELLABLE ending warehouse balance -> unfulfillable_quantity
total_goods_quantity -> 不写入，页面显示 /
```

## 总货量

页面将原“总库存”改名为“总货量”。它是运营判断用的总数量，不再使用旧项目的减法。

```text
总货量 =
  可售
+ 预留
+ 不可售
+ 入库计划
+ 已发货
+ 接收中
```

也就是：

```text
total_goods_quantity =
  fulfillable_quantity
+ reserved_quantity
+ unfulfillable_quantity
+ inbound_working_quantity
+ inbound_shipped_quantity
+ inbound_receiving_quantity
```

同时保留 `amazon_total_quantity` 原始字段，便于对照 Amazon 返回值。

## 数据刷新规则

- 按日期单日请求销量，逐日写入。
- 7 天内的日期允许多次刷新，因为 Amazon 订单和短期数据可能变化。
- 超过 7 天且已有记录的日期默认冻结，不自动覆盖。
- 冻结数据如需修正，后续可以增加“强制重刷”按钮或管理接口。
- 日期选择器需要标记哪些日期已经有本地记录，让用户在选择日期范围前知道哪些日期已经请求过 API 并保存过数据。
- 选择开始日期和结束日期后，不自动触发 API 请求。
- 用户点击“查询”时，系统先查数据库；如果日期范围内有缺失日期，才请求这些缺失日期的 API 并记录。
- 用户点击“同步数据”时，系统强制对选中日期范围逐日请求 API 并记录；超过 7 天且已有记录的冻结日期仍不自动覆盖。
- 一旦某个日期已经保存过 FBA Inventory API 的实时库存快照，后续点击“同步数据”不再覆盖该日期的库存字段，只更新“售卖订单、售卖数量”等销量字段，避免用后续 Ledger 或新的实时快照覆盖历史上保存下来的完整库存状态。

## 充足日规则

`is_sufficient` 是布尔字段，用于标记当天销量是否可用于计算真实日销量。

第一版建议规则：

```text
当天销量 < 前一天可售库存
```

后续可以增强为：

```text
当天销量 < 前一天可售库存
且 前一天可售库存 >= max(5, 近期有效日均销量 * 2)
```

日销量、缺货天数、可售天数、补货建议等运营指标不落库，后续用 Python 或页面逻辑动态计算。

- `缺货天数`：所选日期范围内，该 SKU 当天没有有效库存快照或可售库存为 0 的天数。正常应为 0，用于更醒目地暴露库存数据缺失或断货风险。
- `可售天数`：结束日期总货量 / 所选范围日销量；无销量时显示“无销量”。

## 页面展示

主表不要堆太多概念，第一版展示：

```text
图片
SKU / ASIN / 标题
总货量
可售
入库计划
已发货
接收中
销量
日销量
缺货天数
可售天数
状态
```

`刷新时间` 不放在主表中，必要时后续放入详情。`预留`、`不可售` 可在需要时放入详情或后续展开列。

## 表格交互

FBA 库存表需要支持基础运营筛选能力：

- 自定义显示哪些列，设置保存在浏览器本地。
- 自定义按哪一列排序，并支持升序/降序。
- 支持按数据筛选，第一版以常用字段为主：关键词、库存水平、数值列最小/最大值、文本包含过滤。
- 显示列设置和数据筛选都使用弹窗，不直接铺在主表上方，避免挤占表格可视区域。
- 主工具栏保持简洁，只保留日期、搜索、库存水平、显示列、筛选等入口。
- 表头支持点击排序，当前排序列显示方向标记。
- 后续可增强为接近 Excel 的表头下拉枚举筛选。

## 旧项目参考结论

旧项目 `/Users/bigbang/mine/other_projects/cursor_projects/kanrichu_anlytics` 中曾使用：

```text
FBA库存 = 总库存 + 入库处理中 - 不可售总数 - 预留订单
```

这个算法不继续使用。原因是它依赖导出表字段含义，容易重复或漏算；现在使用 SP-API 原始分项，可以直接保存各状态数量，不需要通过减法倒推。
