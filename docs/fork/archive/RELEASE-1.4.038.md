# 1.4.038 + 请求关联发布候选

## 来源与范围

- fork 功能提交：`a9847f8018a114a22186f2d2e3c2b9bccf8ade07`。
- 作者上游：`04d3a5980dfa672772eeebb3ad23bae46c93216e`（`VERSION=1.4.038`，包含远端内核短时健康探测超时修复）。
- 配套 new-api：`070a5611d25192ea4e7c4ee0aa6345762ab2fc2f`，包含默认失败日志和管理员尝试标识。
- 同步分支：`fork/sync-request-correlation-1.4.038`。不直接覆盖主工作区或线上配置。

保留本次执行/关联 ID、外层重试安全契约，以及原 fork 的提前 SSE、槽位浏览器、代理地域/时区和测试报告功能。冲突逐处解决：面板保留 fork 的代理变更保护及 finally 清理，同时增加上游 worker 查询；服务入口保留原 fork 依赖并接入上游 SQLite pool/write-behind。

## 上游行为变化

- 日志摘要及内部尝试改为同连接延迟批量写入；面板重查询走只读 worker。不能再用“finish 返回即必然落库”作为生产契约。
- 第三方无 TTL 缓存断点按会话 TTL 补齐；隐式 5m 的调用方需要显式指定 5m。
- 官方客户端识别不再等于透传，移除未文档化的 `x-kin-strict-passthrough` 绕过路径。
- GPT 图片模型支持 Chat/Responses 入口，设备迁移后持久化会话绑定，集群页与远端健康判断更新。
- 对比当前 fork 基线，上游未改变 payload、依赖锁文件、Dockerfile 或数据库迁移。新迁移仍只有本功能的 `048_usage_logs_correlation.sql`，增加 nullable 字段和索引。

## 本地同步验证

- 相关日志/数据库测试 104 项通过，包含新增 pooled 模式：关联 ID、外层序号、内部尝试、租户范围、汇总/导出以及 close 时 flush。
- 上游变更与 fork 关键回归合计选择 42 个 Node 测试文件：首轮 1024 项中 1015 通过、1 跳过，8 失败均已局部解释并复验：
  - macOS 长临时路径导致 Unix socket `EINVAL`：以 `TMPDIR=/tmp` 仅重跑 `kernel-router.test.mjs`，51 项通过。
  - 新工作区缺 Linux `kin-oauth-auth` payload：使用相同固定 payload 的隔离 Linux 镜像挂载当前源码和测试、断网运行 `oauth-binary.test.mjs`，8 项通过。不是修改测试跳过，也不是提供商联网验证。
- 日志、集群、JEV 前端共 64 项通过，类型检查通过。

以上是合并内容验证，不代替正式提交镜像的后续验收。最终工件身份、Docker 结果和 PR/CI 状态在交付记录中另列。

## 发布边界

本次授权提交、推送功能分支和创建 PR；未授权合入 dev/main、推镜像仓库或部署生产。正式镜像使用完整源码 Dockerfile，以最终提交 SHA 标记。上线顺序为 vm2api → new-api；原有 routing、环境变量、账号、凭据、指纹、出口和数据库保持原环境所有。迁移先备份，异常回退程序，不用旧数据库覆盖新业务数据。

生产需再次核验实际镜像、架构、挂载、所有槽位与备份；不同实例的数据不自动聚合。新 new-api 缺少明确安全契约时不会重放旧 vm2api 的错误。new-api 默认开启错误日志，但显式 `ERROR_LOG_ENABLED=false` 仍需上线时处理。
