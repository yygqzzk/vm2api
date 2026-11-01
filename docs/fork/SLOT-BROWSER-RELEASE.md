# 槽位浏览器 + 1.4.032 离线上线候选

本次交付包含槽位浏览器、代理池时区联动，以及作者 `v1.4.032`
（`6ff6efd2`）的完整更新。功能用法和隔离边界见 [SLOT-BROWSER.md](SLOT-BROWSER.md)。

## 发布边界

- 只准备到**待切换**：提交、推送 PR、执行 CI、构建验收离线镜像。
- 不在准备阶段替换生产控制面，不修改生产账号/代理选择，不启动生产账号浏览器。
- 1.4.030 → 1.4.032 无新增数据库迁移和依赖升级，但更换作者原版
  `kin-codex-kernel`：SHA256
  `afdb433ebf3c719eb8596e09ca6493e8f769af1aab136426e82cbcd54c9bdc4a`。
  其他 payload 文件哈希保持不变。完整列表以 `deploy/payload.json` 为准。
- 新增 Fast 模型别名和 `gpt-image-2`，以及 OAuth 统一走目标槽出口、拒答错误处理修复。
  不主动改线上模型开关、定价覆盖、账号、调度或路由配置。

## 两份镜像，使用同一候选提交

`ci` 中 `fork-images-amd64` job 在原生 amd64 runner：

1. 检出 PR 的确切 head SHA（不是可变分支名）。
2. 构建原版 Chromium 共享镜像，在真实 Docker network namespace 验证 sandbox、
   profile 隔离、持久化、DNS/UDP/IPv6/内网阻断和失联 lease。
3. 用完整源码 Dockerfile 构建控制面，下载并校验作者固定 payload；在实际镜像内
   执行 fork 首包、OAuth、模型及浏览器/时区契约测试。
4. 只在通过后，将这两份**实际受测镜像**导出到同一个离线包，附归档 SHA256 和
   两份 image inspect 信息。工件名 `fork-images-linux-amd64`，CI 保留 7 天。

镜像引用：

```text
local/vm2api:fork-<完整提交SHA>
local/vm2api-slot-browser:fork-<完整提交SHA>
```

下载后先校验归档 SHA256，再 `docker load`。交付记录必须包含候选提交、CI run、
平台、两个 image ID 和包校验和；不能把旧开发预览的测试结果当作新候选通过。
CI 失败或没有工件时不得标为待切换。

## 切换前必须完成的现场检查

1. 确认目标主机入口、实际架构、运行版本、镜像 ID、Compose project/file 列表及
   全部挂载。旧记录不替代本次现场检查。
2. 确认宿主支持 Chromium unprivileged user namespaces / sandbox；不可通过
   `--no-sandbox`、`SYS_ADMIN` 或关闭 seccomp 兜底。必要时先在目标主机用无账号测试槽验收。
3. 检查 CPU、内存、磁盘余量。两浏览器各限 1536 MiB + 256 MiB shm，按现有推理
   负载额外预留约 4 GiB；镜像共享不等于进程内存免费。
4. 检查控制面 HTTPS/WSS 与反代 Upgrade；browser socket query 中的短期 ticket
   不记录到 access log，VNC/CDP 不开放公网端口。
5. 对 SQLite 作一致性备份，对现场 `.env`、routing、vms/凭证/指纹/代理作受限快照；
   浏览器 profile 是节点 Docker 命名卷，原备份系统不包含它，应另外停浏览器后备份。
6. 记录所有槽位的启停、调度、代理、身份和内核健康；处理在途请求，保留旧镜像与
   原 Compose 覆盖文件。不要用本机测试配置或账号覆盖线上数据。

## 正式切换方案（需另行授权）

沿用现场 Compose，只增加 fork 覆盖文件选择已验收控制面 image ID，并设置
`VM2API_BROWSER_IMAGE` 为已验收的浏览器 image ID。不要直接使用本机预览的 Compose。

更新控制面会加载新版代码和 Codex payload，必须把 Codex 内核重启/健康复核计入
维护窗口；不要只更新网页，也不要无条件重建全部槽位、改指纹或同步 Claude CLI。

切换后逐槽比较保留对象及内核健康；先用无账号浏览器验证画面、出口/时区和停止行为。
真实账号登录由用户执行，真实推理另行授权。出现新增回归，恢复旧控制面 image ID 和
对应覆盖文件，保持当前数据不动；不自动把旧数据库备份覆盖在线数据。

生产入口不可达、架构未知、资源不足、缺少备份或目标环境验收失败时，交付状态必须写成
“本地/CI 工件已准备，服务器侧阻塞”，不能宣称可以直接切换。
