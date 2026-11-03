# new-api 请求关联与外层故障转移

## 身份

- new-api 入口请求 ID `R` 在计费、退款和同请求日志中保持不变。
- 发给一个号池的一次执行使用 `X-Request-Id: R`；外层后续尝试使用 `R-rN`。
- `X-Oneapi-Request-Id: R` 是稳定关联 ID，`X-Oneapi-Retry-Index: N` 是从 0 开始的外层尝试序号。
- vm2api 只将后两项作为诊断元数据，写入普通摘要和 debug 记录；它们不影响权限、会话、计费或内部槽位选择。
- 执行 ID 的唯一约束和内部 `request_attempts` 关系不变。历史记录不通过拆后缀猜测关联 ID。

## 错误契约

协议入口在非 2xx JSON 错误响应中返回 `X-Vm2api-Retry`：

| 值 | 含义 |
| --- | --- |
| `next-channel` | 明确拒绝或未获准执行；允许在其他独立号池做有限故障转移，不表示应立即重打本池。 |
| `never` | 请求级拒绝、绑定状态等不可迁移情况，或者没有更强的安全证明。 |
| `outcome-unknown` | 网络失败、未完成生成、仍持有执行等结果未知情况，不允许静默重放。 |

已提交事件/结果、客户端取消和 WebSocket 的现有禁止重放规则优先。队列保活已提交 HTTP 头时，终止 Anthropic SSE 错误通过 `error.gateway_retry` 携带相同提示。前面任一槽位曾发生结果未知的执行，即使最后一个槽位明确拒绝，也不授权外层重放；不会修改既有的池内恢复策略。

响应头缺失不是允许重试的证明。new-api 每个 vm2api 渠道由运营者保证对应一个独立号池；它无需知道池内账号和额度。一次号池失败后最多再选择一个符合原有分组、模型及亲和约束的其他渠道，不回到已经失败的渠道。

## 查询

- `GET /api/panel/usage-logs?request_id=...`：精确定位一次执行。
- `GET /api/panel/usage-logs?correlation_id=...`：精确定位该关联 ID 下到达本实例的全部执行。
- 对应页面路由为 `/logs?requestId=...` 和 `/logs?correlationId=...`；当前面板使用 hash 路由，实际链接例如 `/cc#/logs?correlationId=...`。
- ID 查询不应用默认错误屏蔽；显式时间、状态、模型等条件及租户权限继续生效。汇总和导出使用相同条件。
- 不聚合不同 vm2api 实例的数据库；历史日志没有关联元数据时用完整执行 ID 查询。

## 升级

迁移 `048_usage_logs_correlation.sql` 仅增加 nullable 字段和查询索引，保留已有数据与执行 ID。推荐先升级 vm2api 再升级 new-api；新 new-api 对没有明确安全契约的旧 vm2api 错误采取不自动重放的保守行为。任何发布或线上升级都须另行授权。
