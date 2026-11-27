# Fork：Codex 首包优化与部署

本目录对应 `yygqzzk/vm2api` 的二开，不修改上游安装脚本、payload 清单、默认 Compose、`VERSION` 或发布流程。

## 行为边界

仅原生 **Responses + stream=true** 提前下发上游真实的 `response.created` / `response.in_progress`，要求带有效 response id、没有错误且状态为 `in_progress`（或未提供状态）。不合成心跳冒充首包。

- `first_byte_ms`：第一个上游协议事件；`first_token_ms`：首段实际生成内容（文字/推理/工具）；new-api 的 `frt` 包含自身排队、网络与反代耗时，首包提前不代表模型更快出字。
- Claude、非流式 JSON、Chat/Anthropic 转换、闭源内核、模型选择、推理强度、凭证与指纹均保持上游原行为。
- **代价：** 真实 lifecycle 首包一旦下发即算已提交，之后失败不能静默换号或重放；未发首包的 HTTP 错误按原逻辑处理，下游须处理流内错误和无 `completed` 的中断。

## 上游接入点与策略模块

策略集中在 `src/lib/transport/codex-stream-policy.mjs`，回归测试在 `test/unit/fork-codex-stream.test.mjs`，部署文件在 `deploy/fork/`。上游仅保留 3 个接入点：

1. `src/lib/protocol/handle-codex.mjs`：仅原生流式 Responses 启用提前下发。
2. `src/lib/transport/codex-kernel-client.mjs`：选择 Codex 专用提交条件。
3. `src/lib/transport/go-worker-client.mjs`：允许传入提交条件，默认条件不变。

不同步覆盖 `src/config/routing.json`，不修改作者 tag，不 fork 整套调度器或运行时热补丁源码。

## 构建与本机隔离验证

- **完整源码构建（`linux/amd64`）：**
  ```bash
  REV=$(git rev-parse --short=12 HEAD)
  docker build --platform linux/amd64 -f Dockerfile \
    --label org.opencontainers.image.source=https://github.com/yygqzzk/vm2api \
    --label org.opencontainers.image.revision="$(git rev-parse HEAD)" \
    --label io.vm2api.fork.feature=codex-early-sse \
    -t "local/vm2api:fork-$REV" .
  ```
- **本机隔离运行（不挂载本机 Docker socket，不导入线上账号，只能验控制面与模拟内核 HTTP/SSE 链路）：**
  ```bash
  mkdir -p .local/fork-docker/{data,vms,config}
  python3 - <<'PY'
  import os, secrets
  p = '.local/fork-docker.env'
  if not os.path.exists(p):
      fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
      with os.fdopen(fd, 'w') as f:
          for k in ('VM2API_LOCAL_API_KEY', 'VM2API_LOCAL_ADMIN_PASSWORD', 'VM2API_LOCAL_DB_SECRET'):
              f.write(f'{k}={secrets.token_hex(24)}\n')
  PY
  docker compose --env-file .local/fork-docker.env -f deploy/fork/compose.local.yml -p vm2api-fork-local up -d --build
  curl -fsS http://127.0.0.1:18787/health
  ```
- **流式回归测试：**
  - 宿主机：`npm ci && node --test test/unit/fork-codex-stream.test.mjs`
  - 镜像内：`docker run --rm --platform linux/amd64 --entrypoint node --mount type=bind,src="$PWD/test/unit/fork-codex-stream.test.mjs",dst=/opt/vm2api/test/unit/fork-codex-stream.test.mjs,readonly "local/vm2api:fork-$REV" --test test/unit/fork-codex-stream.test.mjs`

## 标准化切换（GHCR + cutover.py）

`main` 合入后 CI 的 `ghcr-push` 自动推送 `ghcr.io/yygqzzk/vm2api:fork-<完整SHA>` 与 `vm2api-slot-browser`（离线包另保留 7 天兜底）。`deploy/fork/cutover.py` 固化切换流程：**瘦身一致性备份（~0.8G，排除 `cli-home/.kin` 下可再生内核二进制与 socket，保留最近 `--keep-backups 3` 套）→ `/api/panel/vms/schedule/hold` 暂停调度排空 → 仅替换控制面 → `fleet-update`/`warm` 预热运行中槽位内核 → 逐项验收（失败自动回退，不覆写业务数据库）**。

- **只读与生产切换统一入口（全局技能 `dasixda-ops`，部署须显式指定 `--node`）：**
  ```bash
  OPS=~/Code/dasixda-ops/scripts/ops.sh
  $OPS deploy-vm2api --node <node> --release <完整SHA> --dry-run
  $OPS deploy-vm2api --node <node> --release <完整SHA>
  # 或显式指定 digest 与 slot-browser：
  # $OPS deploy-vm2api --node <node> --digest ghcr.io/yygqzzk/vm2api@sha256:<digest> --revision <SHA> [--browser-image ghcr.io/yygqzzk/vm2api-slot-browser@sha256:<digest>]
  ```
- **首次装机与单槽热重载：** 首次在目标机执行 `cd /opt/vm2api && python3 deploy/fork/cutover.py install` 并配只读 GHCR `docker login ghcr.io`。线上单槽抽样重载时，先 `POST /api/panel/vms/schedule/hold`（`{"reason":"...","ids":["<id>"]}`）确认 `paused: 1, drained: true` 后再 `fleet-update`，并在 `finally` 中 `schedule/resume`（省略 `ids` 为整组维护，空数组会被拒绝）。

## 生产布局与回滚

- **禁止运行面板官方一键升级或 `install.sh`：** 会将 fork 镜像覆盖回官方版本。保留现网 `/opt/vm2api/.env`、`/opt/vm2api/src/config/`、`/opt/vm2api/data/`、`/root/.vm2api/vms/` 与原 `docker-compose.yml`，仅通过 `compose.fork.yml` 覆盖镜像与 `VM2API_BROWSER_IMAGE`。
- **备份与回滚：** 严禁直接复制正在使用 WAL 的 `kin.db`，须走在线 backup API 或 `vm2api-cutover`；切换失败或回滚可执行备份目录内的 `rollback.sh`（或不加载 `compose.fork.yml` 重建 `vm2api`），仅回退程序而不覆盖数据库、凭证、指纹或已有账号槽；跨版本回滚前须核对迁移脚本与 payload 兼容性。
