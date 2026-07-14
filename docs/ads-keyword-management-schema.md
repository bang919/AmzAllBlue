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
| `ads_ai_strategy_versions` | 每个 Profile 的当前 AI 策略规则；保存时替换旧规则，不保留历史版本 |
| `ads_ai_keyword_goals` | 单个关键词的手动调整目标和约束 |
| `ads_ai_analysis_runs` | 每次 AI 分析的输入快照、标准输出、模型和校验状态 |
| `ads_ai_batch_runs` | 每日批量分析的触发时间、关键词集合与一次 CCAI 请求的审计记录 |
| `ads_ai_recommendations` | AI 建议、人工决定、执行结果和复盘时间 |
| `ads_ai_recommendation_events` | 建议生成、拒绝、确认、执行和失败的不可变事件流水 |

## 核心关系

```text
ads_keywords
  └─ ads_campaigns (SP + EXACT/PHRASE/BROAD)
       ├─ ads_ad_units (一个子 ASIN，一个明确 Seller SKU)
       │    └─ ads_performance_daily
       └─ ads_placement_performance_daily

ads_keywords
  ├─ ads_ai_keyword_goals
  └─ ads_ai_analysis_runs
       └─ ads_ai_recommendations
            └─ ads_ai_recommendation_events
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

## AI 分析与执行审计

每次 AI 分析先写入 `ads_ai_analysis_runs`，保存策略版本、关键词目标、近 30 天完整指标数组、建议竞价、最近建议与执行历史。CCAI 返回内容必须通过服务端 JSON 结构、对象归属、当前值和策略安全边界校验，校验失败的分析保存为 `FAILED`，不产生建议。

新分析成功后，上一轮仍未处理的建议转为 `SUPERSEDED`。真正可展示的提醒只统计 `PENDING` 建议。用户拒绝、确认和执行均写入 `ads_ai_recommendation_events`；执行前再次核对数据库当前值，若竞价、预算、位置加价、状态或分组已经变化，则拒绝执行过期建议。

建议状态包括 `PENDING`、`EXECUTING`、`EXECUTED`、`FAILED`、`REJECTED` 和 `SUPERSEDED`。任何真实广告操作均要求用户逐条确认，AI 策略中的 `requireManualConfirmation` 由服务端强制保持为真。

## 数据保留

暂停或移除投放单元不会删除 Amazon ID 和历史日报。结构中不提供级联删除广告业务对象，外键使用 `RESTRICT`，避免误删关键词时连带丢失远端对象关系和历史表现。
