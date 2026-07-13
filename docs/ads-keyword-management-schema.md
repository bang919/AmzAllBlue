# 广告关键词管理数据库结构

本文档记录广告关键词管理第一阶段的 MySQL 表结构及边界。广告模块只管理 `AmzAllBlue_ERP`，Amazon 返回的对象 ID 是远端对象的唯一依据，名称不作为关联键。

## 结构概览

| 表 | 用途 |
| --- | --- |
| `ads_managed_portfolios` | 每个 Profile 唯一受管 Portfolio、验证状态及人工对象冲突 |
| `ads_creation_templates` | 每个 Profile 上一次成功使用的创建模板 |
| `ads_keywords` | 父 ASIN 下的一行关键词、运营分组和创建批次 |
| `ads_campaigns` | 一个关键词的一种 SP 匹配方式，保存创建批次与稳定对象键 |
| `ads_ad_units` | Campaign 下一个子 ASIN/Seller SKU 的 Ad Group、Product Ad 和 Target，保存创建批次与稳定对象键 |
| `ads_performance_daily` | Ad Group 投放单元的每日表现 |
| `ads_placement_performance_daily` | Campaign 按广告位置拆分的每日表现 |
| `ads_sync_jobs` | 异步报表申请、轮询和限流重试任务 |
| `ads_sync_dates` | 日期范围完成状态及日期选择器标记 |
| `ads_operations` | 创建、改名和启停操作的预览、确认及执行状态 |
| `ads_operation_steps` | 每个远端对象步骤的结果，用于失败续传 |

## 核心关系

```text
ads_keywords
  └─ ads_campaigns (SP + EXACT/PHRASE/BROAD)
       ├─ ads_ad_units (一个子 ASIN，一个明确 Seller SKU)
       │    └─ ads_performance_daily
       └─ ads_placement_performance_daily
```

内部主键使用 `BIGINT UNSIGNED`，Amazon ID 使用字符串保存。日报主键不重复保存 Profile、关键词等维度，避免大数据量下重复字段和过大的索引。

## 唯一性与隔离

- 活跃关键词业务唯一范围：`active_scope_key = profile_id + parent_asin + normalized_keyword`；归档时清空该键，允许相同关键词创建新批次。
- Campaign 唯一范围：`keyword_id + ad_type + match_type`。
- 子 ASIN 投放单元唯一范围：`campaign_id + child_asin`。
- Campaign 稳定对象键：`父 ASIN + creation_batch + ad_type + match_type`；投放单元稳定对象键：`子 ASIN + creation_batch + ad_type + match_type`。
- 每个 Amazon Campaign、Ad Group、Product Ad 和 Target ID 在同一 Profile 下唯一。
- 每个投放单元每天最多一条表现；每个 Campaign、日期和位置最多一条位置表现。
- 所有写操作必须从本地对象沿关系追溯到选中 Profile 和 `AmzAllBlue_ERP` Portfolio ID。

## 状态与失败续传

本地分别保存期望状态和 Amazon 当前状态。Campaign 保存 Amazon 当前名称；投放单元分别保存 Ad Group、Product Ad 和 Target 的当前状态。这样可以识别部分改名或部分暂停。

`ads_operations` 保存用户看到的预览及其哈希、确认凭证有效期和执行结果。`ads_operation_steps` 按顺序记录 Portfolio、Campaign、Ad Group、Product Ad、Keyword Target 等步骤。每成功一步立即保存 Amazon ID；重试时跳过已经成功的步骤。

`ads_keywords.creation_batch` 在保存草稿时生成一次，采用 UTC 紧凑时间戳，例如 `20260713T093015123Z`。该值复制到 `ads_campaigns` 和 `ads_ad_units`，预览、确认、创建及失败续传全过程不重新生成。

`ads_sync_jobs.active_dedupe_key` 只在任务处于活动状态时有值，利用唯一索引阻止同一报表并发重复申请；任务结束后清空，允许以后重新覆盖同步同一日期范围。

## 数据保留

暂停或移除投放单元不会删除 Amazon ID 和历史日报。结构中不提供级联删除广告业务对象，外键使用 `RESTRICT`，避免误删关键词时连带丢失远端对象关系和历史表现。
