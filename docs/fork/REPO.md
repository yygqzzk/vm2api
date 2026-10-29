# Fork 仓库

本文件是 `yygqzzk/vm2api` 的仓库地图。构建和上线步骤在 [DEPLOY.md](DEPLOY.md)。一次验收的记录在 [VALIDATION.md](VALIDATION.md)，对不上本次提交的记录不算本次通过。

## 身份

- 本仓库是 fork。作者上游是 `dofastted/vm2api`，以远程 URL 为准。
- `VERSION` 是上游兼容基线。fork 的发布身份是镜像标签和 OCI revision。
- 现有 fork 行为是 Codex 原生流式 Responses 提前下发上游真实 lifecycle。策略在 `src/lib/transport/codex-stream-policy.mjs`。上游接入点是 `src/lib/protocol/handle-codex.mjs`、`src/lib/transport/codex-kernel-client.mjs`、`src/lib/transport/go-worker-client.mjs`。
- 远程 tag `v1.3.226` 留在作者提交上。fork 发布用镜像标签和 revision。

## 改动

1. 从当前 fork `main` 建 `fork/<topic>`，放在仓库旁的 worktree。
2. 策略放进职责明确的模块；上游文件只加接入点。
3. 用 PR 合回本仓库 `main`，让 `ci` 在进入 `main` 之前跑。紧急修复可以直接推 `main`。

完成条件：改动在 `fork/<topic>` 上，或在说明过的 `main` 提交上，并且该提交的 `ci` 已排队或已有结果。

## CI

页面上的开关为准。workflow 文件留在仓库里，这样同步上游时不用解决整文件冲突；Actions 里关掉的 workflow 不会因为合并上游而重新执行。

| workflow | 文件 | 本 fork |
| --- | --- | --- |
| `ci` | `.github/workflows/test.yml` | 开。推 `main`、任意 PR、手动。这是门禁。 |
| `pr-rerun` | `.github/workflows/pr-rerun.yml` | 开。`main` 的 `ci` 从失败恢复后，重跑因此失败的 PR。 |
| `release` | `.github/workflows/release.yml` | 关。镜像按 [DEPLOY.md](DEPLOY.md) 手工构建。 |
| `guest-images` | `.github/workflows/guest-images.yml` | 关。 |
| `oneshot-*-226` | `.github/workflows/oneshot-*.yml` | 关。目标是作者仓库。 |

完成条件：需要门禁的改动，走会触发 `ci` 的 PR 或 `main` 推送。

## 本地文件

- 仓库根的 `docker-compose.override.yml` 被忽略，Compose 仍会自动加载。WSL 控制台转发只放在需要它的机器上。
- `.local/` 和根目录 `AGENTS.md` 被忽略。要提交的代理说明写在本目录。

## 同步上游

fetch 作者远程，把作者 `main` 合并进 fork `main`。保留上面的策略模块和三个接入点，保留作者 tag。合完按 [DEPLOY.md](DEPLOY.md) 跑受影响的回归。

完成条件：合并结果包含当时的作者 `main`，接入点还在，相关检查有本次结果。
