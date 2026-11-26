# Fork 验收记录

## 上游同步验收（2026-10-28）

### 合并范围与兼容处理

- fork 基线：`533abcdf`；合入上游 `35f62b61054b7237a44e2b57ee162a89e417ddb2`。
  本地原先落后 origin/main 的 10 个提交先做快进，不改写已有历史。
- 上游 `VERSION` 为 1.4.023，另含 main 上尚未发布的修复。
- 唯一文本冲突位于 `codex-kernel-client.mjs`，保留 fork lifecycle 提交条件，
  同时保留上游 `maxRequestBytes`。新增两例验证开关两种状态下都拒绝超限 envelope。
- 原有三个上游接入点及独立策略模块保留；不改 `src/config/routing.json`。
  Node、Web、Go 依赖清单及锁文件未变。
- 新 ARM64 打包脚本补上 tar 成员内容为空的显式校验，并增加对应单测；
  修正相关 Python 可选值类型诊断。
- 新版构建改用完整源码 `Dockerfile`；旧 1.4.015 派生入口新增版本保护。
  在已有 1.4.015 本机镜像中确认版本比较会拒绝本次新版源码。

### 已通过

- macOS/arm64，Node **22.23.4**，按项目逐文件隔离方式运行 Node 测试。
- 五个直接受影响的 Codex/共享转发测试文件：**128/128** 通过。
- Web：**71 个文件、542 项**通过；`format:check`、TypeScript/Vite 构建通过。
  使用项目 CI 约定的 pnpm 10 安装冻结锁文件；宿主 pnpm 11 不兼容旧 overrides 配置，
  未因此修改锁文件。
- worker：`go vet ./...`、`go test -race ./...` 通过。
- api-kernel：`go vet ./...`、`go test ./...` 通过。
- ARM64 打包 Python 单测：**8/8** 通过。
- Biome 格式、Node 源码语法、Go 格式、`git diff --check` 通过。
- 本机 Compose 配置校验通过；生产覆盖配置使用 `--no-env-resolution` 校验通过，
  未创建、读取或替换生产 `.env`。
- 九个核心改动/配置路径主动 LSP 检查无错误；生产 Compose 的 LSP schema
  下载遇到 `ECONNRESET`，不作为通过，已另用 Docker Compose 实际解析校验。
- 辅助 ast-grep 规则另报 `config.mjs:280` 的未捕获 JSON 解析及两处嵌套三元表达式。
  这些代码在 fork 基线和本次上游中已有，合并未修改；`saveVmPatch` 当前无调用方，
  读取/解析失败会向上传递而非用默认值覆盖文件。本次未为消除静态告警改变其错误语义。

### 已有环境失败，不能视为全量通过

最终 Node 全量：**313 个文件；3977 通过、14 失败、27 跳过**（共 4018 项，
含嵌套子测试），8 个文件失败：

- `cluster-placement.test.mjs`
- `egress.test.mjs`
- `guest-identity-reader.test.mjs`
- `host-path.test.mjs`
- `oauth-binary.test.mjs`
- `session-oauth-seam.test.mjs`
- `slot-recovery.test.mjs`
- `slot-shell-rc.test.mjs`

将未修改的上游 `35f62b61` 导出到独立 `/tmp` 目录，以相同 Node、依赖和
宿主环境逐文件重跑这 8 个文件；合并树与上游均为 **102 通过、14 失败、
18 跳过**，失败文件及具体用例名完全相同。涉及缺少 Linux payload/helper、
宿主 Docker/Unix-socket/系统命令差异；没有为绿灯改动这些上游测试或实现。
发布前仍应在完整 Linux payload 环境补齐全量验收。

### 未执行与升级风险

- 未构建新版完整 Docker 镜像、未运行 ARM64 容器打包 smoke、未用真实账号推理，
  未做线上 new-api A/B；没有推送、发布或部署，也未修改线上数据。
- 上游新增迁移 045–047（045 随 fork 远端已有提交进入本地），更新了 kernel、
  cli-node 与 worker 遥测；还有 Codex Key 门禁扣费、32 MiB 缺省限额、流式判定与
  service tier 计费口径变化。跨版本上线/回滚不能沿用旧同版补丁流程，
  详见 `DEPLOY.md` 与上游 `CHANGELOG.md`。

## 首包优化历史验收（2026-10-27）

## 已完成

- 运行环境：Docker Desktop / linux/amd64（Mac 上模拟），Node 22，
  官方 1.4.015 digest 固定的派生镜像。
- 构建前校验三个基础模块 SHA256：全部一致。
- 宿主机按项目方式逐文件隔离运行五个相关测试文件：71 项通过。
- 派生镜像内运行 `fork-codex-stream.test.mjs`：13 项通过，无跳过；
  同一 linux/amd64 镜像逐文件运行上述五个相关测试文件：71 项全部通过。
- 本机实例 `vm2api-fork-local-vm2api-1`：启动成功，
  `/health`、`/cc/`、`/api/panel/version`、`/api/panel/vms` 均 HTTP 200。
- 本机隔离账号数：0，没有复制生产凭证或数据。
- 七个变更代码/Compose 文件主动 LSP 检查：无诊断。
- Biome 格式检查和 `git diff --check`：通过。

## 真实 HTTP 时序对照（受控内核，不是官方模型测速）

受控 Unix-socket 内核先发送 `response.created`，等待 600ms 再发正文。
通过真实 `handleCodexProtocol` 和转发模块，用 HTTP 客户端收包：

| 策略 | 下游首包 | 下游正文 | 日志真正 TTFT |
| --- | ---: | ---: | ---: |
| 原上游提交策略 | 613ms | 613ms | 606ms |
| fork 首包策略 | 5ms | 611ms | 607ms |

数字是该次容器测试样本，不是性能保证。实现消除了网关在首包前的人为等待，
没有把协议事件当正文，也没有改小 TTFT。

## 已有基线问题与未验证范围

全量 `npm run test:unit` **未全通过**：294 个文件中 27 个失败。
将未修改 HEAD 导出到独立目录，在同一宿主环境重跑这 27 个文件：
基线同样 27 个文件、88 个不同失败用例，本补丁没有新增失败用例名。
涉及 Claude betas/persona、指纹、二进制依赖等，未在本次修复中扩大范围。
一次并行相关测试出现旧的进程启动测试偶发失败；按项目的逐文件隔离方式
重跑上述 71 项后全部通过。

未运行 Go/Web 全量测试：本次未改 Go、Web、依赖或闭源 payload。
没有用真实生产账号发推理请求，未验证真实模型的正文首字速度或额度消耗。
没有在实际 new-api 线上链路做 A/B，也未替换线上控制面。
首包发出后取消静默重试是明确的行为变化，正式上线需先安排在途请求清空。

本机隔离实例不挂载 Docker socket，因此启动时的
“slot create/start will fail” 是预期的隔离限制，不是本次启动失败。
