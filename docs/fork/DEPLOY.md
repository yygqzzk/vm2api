# Fork：Codex 首包优化与部署

本目录对应 `yygqzzk/vm2api` 的二开，不修改上游安装脚本、payload 清单、
默认 Compose、`VERSION` 或发布流程。

## 行为边界

仅原生 **Responses + stream=true** 提前下发上游真实的
`response.created` / `response.in_progress`，要求带有效 response id、
没有错误且状态为 `in_progress`（或未提供状态）。不合成心跳冒充首包。

- `first_byte_ms`：第一个上游协议事件。
- `first_token_ms`：首段实际生成内容；仍可能是文字、推理或工具内容。
- new-api 的 `frt`：它收到第一条 SSE data 的时间，不能等同于文字首字。

首包提前不代表模型更快生成正文，也不保证 new-api 一定显示绿色。
仍需加上 new-api 自身排队、网络和反向代理耗时。
Claude、非流式 JSON、Chat/Anthropic 协议转换保持上游原有提交边界。
闭源内核、模型选择、推理强度、凭证和指纹不变。

**代价**：真实 lifecycle 首包一旦交给下游，本次请求就已经提交。
之后失败不能静默换账号或重放；未发首包的 HTTP 错误仍按原逻辑处理。
下游必须处理流内错误和没有 completed 的中断，不把 HTTP 200 当完整成功。

## 为什么保持少量上游接入点

新增策略在 `src/lib/transport/codex-stream-policy.mjs`，回归测试在
`test/unit/fork-codex-stream.test.mjs`，部署文件在 `deploy/fork/`。
上游文件只保留三个必要接入点：

1. `handle-codex.mjs`：仅原生流式 Responses 启用提前下发。
2. `codex-kernel-client.mjs`：选择 Codex 专用提交条件。
3. `go-worker-client.mjs`：允许传入提交条件，默认条件不变。

不 fork 整套调度器、不 monkey-patch、不在启动脚本替换源码。
这些位置仍可能和上游产生冲突，不能保证零冲突。
同步上游时正常 `git fetch upstream`、`git merge upstream/main`，
保留这几个接入点并重跑回归；不要覆盖 `src/config/routing.json`。
发布只推自己的 fork，不用 force push，不修改作者的 tag。

## 构建 fork 镜像

新版上游使用仓库根目录的 **完整源码 `Dockerfile`** 构建：它包含合并后的
Node 模块、Web、源码构建的 API helper 与 `deploy/payload.json` 固定的 payload。
完整源码会直接包含 fork 的三个接入点及独立策略模块，不需要覆盖运行时文件。

`deploy/fork/Dockerfile` 仅保留为历史 **1.4.015 专用**派生镜像入口，
基础 digest、三个模块校验值和四模块覆盖清单均未适配新版。
版本检查会拒绝将新版源码叠加到旧运行环境；不要改 tag 或绕过校验。

从仓库根目录构建与线上同架构的镜像（线上为 linux/amd64）：

```bash
REV=$(git rev-parse --short=12 HEAD)
docker build --platform linux/amd64 \
  -f Dockerfile \
  --label org.opencontainers.image.source=https://github.com/yygqzzk/vm2api \
  --label org.opencontainers.image.revision="$(git rev-parse HEAD)" \
  --label io.vm2api.fork.feature=codex-early-sse \
  -t "local/vm2api:fork-$REV" .
```

构建前先提交并验收合并结果，确保镜像标签和 revision 对应完整源码。
`VERSION` 继续表示兼容的上游版本，fork 身份以镜像标签和 OCI revision
label 为准。当前上游基线读仓库根目录的 `VERSION`。

## 本机隔离部署

不会使用仓库原有的 WSL override，不挂载本机 Docker socket，
不导入线上账号。这样只能验证控制面与模拟内核的 HTTP/SSE 链路，
不能在这个隔离实例创建真实 Docker 槽位。

创建随机的本地专用密钥（不要复制生产 `.env`）：

```bash
mkdir -p .local/fork-docker/{data,vms,config}
python3 - <<'PY'
import os, secrets
p = '.local/fork-docker.env'
if not os.path.exists(p):
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f:
        for k in ('VM2API_LOCAL_API_KEY', 'VM2API_LOCAL_ADMIN_PASSWORD',
                  'VM2API_LOCAL_DB_SECRET'):
            f.write(f'{k}={secrets.token_hex(24)}\n')
PY

docker compose --env-file .local/fork-docker.env \
  -f deploy/fork/compose.local.yml -p vm2api-fork-local up -d --build
curl -fsS http://127.0.0.1:18787/health
```

面板：`http://127.0.0.1:18787/cc`。
密钥仅保存在被 git 忽略的 `.local/fork-docker.env` 中。
`.local/fork-docker/` 也不应提交或上传。

## 流式回归验证

宿主机：

```bash
npm ci
node --test test/unit/fork-codex-stream.test.mjs
```

在实际完整源码镜像中测试（生产镜像不打包测试文件）：

```bash
docker run --rm --platform linux/amd64 --entrypoint node \
  --mount type=bind,src="$PWD/test/unit/fork-codex-stream.test.mjs",dst=/opt/vm2api/test/unit/fork-codex-stream.test.mjs,readonly \
  "local/vm2api:fork-$REV" --test test/unit/fork-codex-stream.test.mjs
```

测试用假的账号和受控 Unix-socket 内核发包，但运行实际的
`handleCodexProtocol`、Codex client 和共享转发器，再通过真实 HTTP 客户端
收包。固定推迟 600ms 才给正文，分别验证旧策略与新策略；首包能提前，
真正 TTFT 不被改小。另测断包、取消、诊断头不泄露、首包前可重试、
首包后不能重试，以及 JSON/转换路径不受影响。
这不是官方模型的真实测速，不消耗生产账号额度。

## 准备部署到现有服务器（手动执行，非本机验证的一部分）

线上现有布局不能换成仓库默认挂载：

- 配置：`/opt/vm2api/.env`、`/opt/vm2api/src/config/`。
- 数据库和日志：`/opt/vm2api/data/`。
- 账号、凭证和指纹：`/root/.vm2api/vms/`。
- 原有 `/opt/vm2api/docker-compose.yml` 保留不动。

1. 先记录镜像 ID、容器 Mounts、10 个槽的 ID 和健康状态。
   对 SQLite 使用在线 backup API 备份，不单独复制正在使用 WAL 的 `kin.db`；
   另备份 `.env`、config、原 Compose、vms 的配置/凭证/指纹，权限限制为 root。
   确认有可恢复备份后再继续，不删除旧镜像。
2. 将上面构建的 **linux/amd64** 镜像导入服务器；仅复制生产覆盖文件，
   不上传本机 `.env`、routing、data、vms 或 WSL override：

   ```bash
   docker save "local/vm2api:fork-$REV" | gzip > ".local/fork-$REV.tar.gz"
   scp ".local/fork-$REV.tar.gz" vm2api:/tmp/
   scp deploy/fork/compose.production.yml vm2api:/opt/vm2api/compose.fork.yml
   # 以下在服务器上执行，REV 替换成已验收的具体提交号。
   gunzip -c /tmp/fork-$REV.tar.gz | docker load
   ```

3. **跨版本升级前另行验收**：1.4.015 → 本次同步结果涉及迁移 045–047、
   新 kernel / cli-node payload 和 worker 遥测变更；还包含托管 API Key 的
   Codex 门禁扣费、缺省请求体上限 32 MiB、流式判定与计费档位变化。
   详见 `CHANGELOG.md` 的 1.4.018–1.4.023 条目。先用隔离数据副本验证迁移，
   再安排 payload / worker 更新与槽位刷新；不能沿用同版补丁“不刷新槽位”的前提。
   下列命令仅替换控制面，不代表跨版本升级已经完成。

   在服务器 `/opt/vm2api` 使用两个明确的 Compose 文件，避免自动载入
   本机 WSL override；先验证配置，再替换控制面：

   ```bash
   cd /opt/vm2api
   export VM2API_FORK_IMAGE="local/vm2api:fork-$REV"
   docker compose -f docker-compose.yml -f compose.fork.yml config --quiet
   docker compose -f docker-compose.yml -f compose.fork.yml \
     up -d --no-deps --pull never vm2api
   curl -fsS http://127.0.0.1:8787/health
   ```

   此操作会短暂中断控制面；先等在途请求结束。
   不运行 install.sh、面板官方升级或未经验收的槽位重建。
   入口会刷新程序二进制，应用也可能迁移数据库或规范化配置，
   所以必须有上一步备份并复核，而不是承诺整个运行目录字节永远不变。

4. 核对新容器的镜像 label、数据库与账号数量、原有路由/出口/指纹，
   再逐个检查 10 个 Codex 内核健康。随后通过实际 new-api 路径抽样，
   分开观测首包与真正首字。不要只看面板的版本号或红绿颜色。

回滚使用原 Compose 中已记录的官方镜像，不加载 fork 覆盖文件：

```bash
cd /opt/vm2api
docker compose -f docker-compose.yml up -d --no-deps --pull never vm2api
```

这只回退程序，不恢复/清空数据库，不删除账号槽。
本次同步新增迁移 045–047；跨版本回滚还须核对数据库、payload 和 worker
兼容性，必要时按已验收的备份恢复流程操作，不能只换旧镜像就视为完成。

后续重建/重启控制面都要明确带 `-f compose.fork.yml`。
面板中的官方一键升级不知道 fork 镜像，可能覆盖回官方版，不要混用。
