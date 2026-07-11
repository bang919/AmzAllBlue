# 工厂库存功能需求

## 目标

工厂库存模块用于维护国内工厂/仓库中的成品库存，展示位置在 FBA 库存模块上方。它和 FBA 库存分开记账，但商品主数据优先复用 FBA 库存已有的商品数据库。它解决的问题是：

- 当前每个 ASIN 在工厂还有多少现货
- 哪些商品低于安全库存，需要安排生产或补货
- 哪些商品已经从工厂发往 FBA 或其他渠道
- 每一次补货、发货、盘点调整都有时间顺序流水可追踪

本功能只管理成品库存，导入历史表格时忽略辅料列。

## 数据对象

工厂库存使用本机 MySQL 持久化。服务层仍向业务代码提供以下逻辑结构：

```text
factoryInventory.products
factoryInventory.movements
```

数据库中按相同字段拆成两张表：

```text
factory_inventory_products
factory_inventory_movements
```

## 商品档案字段

`factoryInventory.products` 每一行代表一个工厂库存商品的工厂库存扩展数据。页面展示商品时，优先使用 FBA 库存商品库里的 ASIN、SKU、标题、图片等主数据；CSV 只补充工厂库存数量、箱规、成本和历史流水。CSV 中存在但 FBA 商品库暂时没有的 ASIN，先作为工厂库存商品保留，后续 FBA 同步到该 ASIN 后自动合并展示。

```text
id
name
asin
boxSpec
unitCost
currentQuantity
safetyStock
note
source
createdAt
updatedAt
```

说明：

- `currentQuantity` 是当前工厂库存的权威值。
- `unitCost` 来自原表“单个成本”。
- `boxSpec` 来自原表“箱子规格”。
- `safetyStock` 第一版统一默认为 50，后续可按商品销量、生产周期、FBA 可售天数自动建议。

## 库存流水字段

`factoryInventory.movements` 每一行代表一次库存变动。

```text
id
productId
date
type
quantity
note
operator
source
createdAt
```

`quantity` 使用带符号数量：

- 正数：补货入库、追加入库
- 负数：发货出库
- 正数或负数：库存调整、盘点差异

`type` 第一版：

```text
inbound
outbound
adjustment
import
```

## 导入规则

参考文件：`库存-喜悦库存.csv`。

- 第 2 行作为 CSV 商品别名；页面商品名优先使用 FBA 商品数据库标题，CSV 名称作为备注保留。
- 第 3 行作为 ASIN。
- 第 4 行作为箱子规格。
- 第 5 行作为当前剩余库存。
- 第 6 行作为单个成本。
- 第 8 行开始作为历史流水。
- 遇到“辅料”后的列全部忽略。
- 空白数量不生成流水。
- 历史流水按原表日期保存，页面按日期倒序展示。

## 页面能力

第一版页面使用单张横向矩阵表，不再拆成商品表和流水表。

- 每一列代表一个工厂库存商品/ASIN。
- 顶部固定行依次为：图片、ASIN、单个成本、箱子规格、剩余库存、货值。
- `ASIN`、`单个成本`、`箱子规格` 可以直接在表格顶部编辑，失焦后保存回工厂库存数据库。
- `货值` 使用 `剩余库存 * 单个成本` 动态计算；如果来源 Excel 的货值行漏填，以系统计算值为准。
- 每一条库存流水聚合成一行，最左第一列是操作，第二列是日期，后续各列是对应 ASIN 的变动数量。
- 搜索：按品名、ASIN、箱规过滤列。
- 库存状态筛选：全部、低库存、缺货、正常。
- 手动补货/发货：选择商品、类型、日期、数量和备注，保存后追加流水并更新当前库存。

## 后续增强

- 每个商品单独维护安全库存和生产周期。
- FBA 库存低于可售天数阈值时，联动提示从工厂发货。
- 工厂库存不足但 FBA 缺货风险高时，生成生产建议。
- 增加批量导入新版 Excel/CSV。
- 增加操作人、附件、箱数、物流单号、目的仓字段。
- 增加按 ASIN 的工厂库存 + FBA 总货量统一看板。
