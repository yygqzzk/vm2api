# 槽位浏览器（fork）

Linux Docker 槽的按需浏览器，可日常浏览和登录授权。使用基于 Chromium 的 Chromix、有头桌面、TigerVNC、noVNC，不改变 vm2api 推理内核。每节点共享一份镜像，每槽独立容器、持久化 profile 和固定浏览器指纹种子。控制面同时最多 2 个浏览器，每节点也检查 2 个上限。

## 使用前

在**每个承载槽位的 Linux Docker 节点**构建一次：

```bash
docker build -t local/vm2api-slot-browser:3 docker/fork/slot-browser
```

控制面默认只使用节点上已经存在的这个镜像，不自动下载、构建或更新。可以通过 `VM2API_BROWSER_IMAGE` 指定自己已构建的固定镜像 ID/digest；所有节点必须有对应镜像。发布时记录镜像身份和 Chromium 版本，定期重建安全更新，不长期冻结旧浏览器。

当前固定 [Chromix v156.0.8078.79](https://github.com/xiaozhou26/Chromix/releases/tag/v156.0.8078.79)，支持 Linux amd64/arm64。构建时下载官方 ZIP 并核对代码中固定的 SHA-256；也可以把同名、未修改的 `chromix-linux-x64.zip` 或 `chromix-linux-arm64.zip` 放入 `docker/fork/slot-browser/archives/` 离线构建，仍须通过相同校验。ZIP 被 git 和控制面构建上下文忽略，不进入最终浏览器镜像。浏览器发行包自带的许可证文件随二进制保留；更新内核时同时复核其许可及依赖声明。

镜像 CPU 架构必须与 Docker Engine 一致。启动时拒绝跨架构模拟：模拟环境可能让 Chrome 运行却无法安装其内部 seccomp 过滤器，不能拿“页面可打开”当作沙箱正常。Mac 上的 Docker 应构建和使用原生 arm64 镜像；amd64 的完整容器验收须在原生 amd64 Linux 节点/CI 执行。

控制面要求镜像带有 `io.vm2api.browser.fingerprint=chromix-2` 标记，拒绝旧 `:1` / `:2` 镜像；新标记包含标签页恢复和持久身份校验契约。检查后使用实际 image ID 启动，避免 tag 切换造成版本错配。升级前停止浏览器并备份 profile 卷，再构建新镜像和更新控制面。旧 profile 首次启动保留种子和网站数据，只补身份校验标记；恢复旧程序/浏览器前使用升级前备份，不能假设新版 Chrome profile 可向后兼容。

需要 Docker Engine、可用的 unprivileged user namespaces 和允许其运行的宿主 AppArmor 配置。运行时使用固定 Moby 默认 seccomp 加 Chromium sandbox 所需的命名空间调用，不授予 `SYS_ADMIN`，不使用 `--privileged`、`seccomp=unconfined` 或 `--no-sandbox`。宿主禁止 user namespaces 时启动失败，不静默降低隔离。

每个活跃浏览器限额：1 CPU、1536 MiB 内存（不增加 swap）、256 MiB `/dev/shm`、256 个 PID。两个窗口应在原有推理负载之外预留约 4 GiB 内存。镜像只读层共享，进程内存不共享。

更新控制面源码及前端构建；原槽不需要安装 Chrome、重编 payload 或改变推理内核。已有槽必须先启动且出口网络已经与绑定代理一致。远程 Linux Docker 节点复用 `slotHost().dockerApi()` 的 SSH 通道，不开放远程 Docker TCP。

## 日常浏览与授权

槽位详情顶部 →「打开槽位浏览器」，无需凭证或授权链接；槽位及绑定出口须已运行。普通打开重连现有窗口，不再额外打开供应商首页。浏览器停止后重新打开，通过 Chromium 原生会话恢复上次标签页；新环境显示浏览器新标签页。日常浏览与授权共用本槽 profile。

有授权链接时，选「在槽位浏览器中授权」，在同一浏览器中新开标签，不清空已有页面。Claude 原生 CC 登录终端也提供这个入口。

- Claude：继续使用现有官方 CLI/授权链接流程。在远端浏览器登录并授权，复制授权码，通过「复制远端剪贴板到本机」取回，关闭画面后回填原来的终端或授权码输入框。浏览器不提取 Cookie、不另建刷新器。
- Codex：继续由现有 PKCE 逻辑生成链接；旁车只在自身 `127.0.0.1:1455` 接回调，校验 Host、路径、state、有效期和重复回调。控制面经受保护的通道读取并提交现有 `/oauth/exchange-code`。自动提交失败不会循环重放；可以明确点击重新检查或使用原手动回调入口。
- 普通「打开授权页」仍打开操作员本机浏览器，需自行配置其代理；它不是槽位浏览器。
- 中文可以通过面板剪贴板输入：发送后在远端按 Ctrl+V。远端复制不会自动写入本机剪贴板，须明确点击复制按钮。浏览器内 Ctrl+L 可输入地址。
- 顶部「关闭画面」只断开画面，闲置最多保留 5 分钟用于重连；「停止浏览器并保存」立即正常关闭 Chromium，保留身份、网站资料和可恢复的标签页，画面无法连接时也可以操作。退出 Chrome 最后一个窗口也会结束桌面。会话恢复不能恢复尚未提交的表单、内存状态，或保证网站登录仍然有效。
- 控制面/SSH 失联导致心跳超过 45 秒时，容器内独立 lease 结束桌面。关闭时优先发正常窗口关闭请求，保留 X server 到 Chromium 退出，避免 Cookie 写入丢失。崩溃/断电仍不保证最后几秒数据落盘。

一个槽同一时间只有一个画面控制者。仅 admin 可使用；user 与 super 不可查看画面或操作，与上游 1.4.051 的租户凭据只读限制一致。权限、会话撤销和属主变化会重新检查。ticket 30 秒内有效、单次使用、绑定槽/浏览器会话/Origin。VNC 和控制协议只监听容器 Unix socket，借 Docker exec 二进制流转发，不发布 5900、6080 或 CDP 端口。

公开控制面必须使用 HTTPS/WSS；反向代理需转发 WebSocket Upgrade，参见 `docs/nginx-shell.md`。跨源控制面使用现有 `PUBLIC_BASE_URL` / `PANEL_CORS_ORIGINS`。禁止代理 access log 记录 `/browser/socket` 的 query 参数，避免记录短期 ticket；应用不记录输入、授权码、密码或画面。

## 出口与指纹边界

浏览器有独立 network namespace，加入该槽受控出口网络，**不共享原槽 localhost**。TCP/DNS 复用现有 kin-egress → SOCKS5，不将代理密码放入浏览器环境变量。SOCKS 出口网络必须关闭 IP masquerade，缺失/不合规时拒绝启动。

浏览器入口只在其容器 namespace 内设置防火墙，随后降为 UID/GID 1000 并清空 capabilities：

- DNS TCP/UDP 53 强制交给指定 helper；规则在 Docker `127.0.0.11` 的规则之前。loopback 源只对这个 DNS 目的做 SNAT；`route_localnet` 也仅设在该旁车内。Docker resolver 不能回退到宿主 DNS。
- INPUT/FORWARD 默认 DROP；OUTPUT 只允许必要的 loopback、指定 DNS 和经槽网络的公网 TCP。阻断宿主网桥、其他容器、RFC1918、CGNAT、link-local/云元数据、组播等目的。
- 非 DNS UDP 被丢弃；禁用 QUIC、浏览器自行选用的 DoH，WebRTC 设为 `disable_non_proxied_udp`，并用网络层兜底。
- 关闭 IPv6 地址配置且 IPv6 防火墙默认 DROP。支持 IPv6 **代理服务器地址**不等于允许浏览器另走公网 IPv6；前者仍由现有出口 helper 处理。
- `px-local` 是显式节点直连，UI 明确提示会暴露节点公网 IP，DNS 使用指定公共解析器。若本地 Codex 槽另有部署级代理，浏览器拒绝启动并要求显式绑定同一 SOCKS5，避免网页登录与推理出口不同。

代理断开时不回落直连。换代理、变更属主、重建/停止槽位等控制面操作先停浏览器；操作结束前阻止重新启动。用户编辑自己的代理不会停止其他租户的浏览器。直接在宿主修改 Docker/iptables 不在控制面事务保护范围，运维必须保持出口网络规则。

环境来自槽的 `timezone` / UTF-8 `locale`；`navigator.language/languages`、Intl、Accept-Language 对齐配置。槽位的语言或时区变化时停止旧浏览器，重新打开继承新值，不重抽种子或清理资料。显示及暴露的 screen 固定 1280×800，控制面只缩放画面。网页可见 CPU/内存固定呈现为 8 核 / 8 GiB；这不增加容器实际资源限额。UA/Client Hints 使用 Chromium/Linux，不伪造 Windows/macOS。每槽首次启动生成随机种子，以 Chromix 原生参数启用 `fingerprint-pixel-noise=seeded` 和 `fingerprint-audio-render=isolated`，让同槽 Canvas/Audio 输出稳定、不同槽产生不同输出；没有注入网页 JavaScript。仅设置 seed 并不足以得到上述效果。

画面显示由种子摘要得到的「环境标识」，方便核对同槽重开、资料清理和环境联动时是否仍使用同一身份。它不代表全部可见特征的摘要：语言、时区、出口 IP 会按槽配置变化；升级内核、字体、驱动或跨架构迁移还可能改变原生特征，须另做兼容验收。

WebGL 沿用默认可用性，不开启不安全的软件渲染开关；无 GPU 容器可能返回 null。硬件、字体、GPU、屏幕等特征仍可能相同，这不是整套商业指纹浏览器或防关联保证，也不承诺绕过网站风控。同代理 IP 不会因 profile/seed 隔离变成不同 IP。升级 Chromix 也可能改变输出，需重新验收。

不支持本机安全密钥/生物识别自动转发、摄像头/音频、自动验证码、KVM 或 macOS 原生槽。需要这些能力另行评估。

## 代理池与时区联动

浏览器不是直接读取上一次检测的时区。每次打开前，经槽位当前绑定出口强制刷新地理信息；检测成功后同步该代理绑定槽位的自动时区，再启动浏览器。`timezone_source=manual` 和全局关闭“跟随代理时区”仍优先，不擅自覆盖。

- 换绑代理：重新检测实际出口。编辑现有代理的 host/port/username/password 且值真正改变时，旧 IPv4/IPv6 地理缓存失效，检测新出口并同步绑定槽位。只改名称或提交相同连接字段不重启浏览器。
- 单条、批量「测地理」共用时区同步流程；只停止出口或时区实际改变的浏览器，其他代理的槽不受影响。
- 运行中按代理合并复核，每 60 秒检查正在运行的浏览器所用出口，不扫描闲置代理池。一个代理上两个浏览器共用一轮检测。实际检测还需网络响应时间，不承诺换节点后零延迟识别。
- 确认出口 IP、自动时区或代理连接信息变化：旧浏览器停止并通过画面提示重开；Cookie/profile 保留，不自动恢复可能已失效的授权页。旧浏览器的 Codex 授权需重新生成链接。
- 打开前检测失败不使用旧缓存冒充验证成功；运行中仅地理服务失败不等于出口改变，保留现有浏览器并显示“出口复核失败”，等待下一轮或管理员「测地理」。不把瞬时地理 API 故障当成账号/代理失效。
- 检测过程中发生换绑、手动固定时区或新一轮检测时，迟到结果不能覆盖新配置。

这套逻辑作用于通用代理池，包括固定 SOCKS5、相同入口后面的动态节点和远程节点本地出口，不依赖 Clash。浏览器语言始终继承槽位当前 locale，不额外按国家猜测或单独冻结。

## 数据、重建与删除

浏览器 profile 放在**槽位节点的 Docker 命名卷** `kin-browser-profile-<slot-id-sha256前24位>`，不是放进现有 CLI home。这样不会暴露 API 凭证目录，也不受原槽的 home 重建影响。只读镜像没有账号或代理凭证。卷内 `/profile/browser-identity.json` 保存版本与固定种子，`browser-identity.sha256` 保存身份校验标记，网站数据位于 `/profile/chromium/`。已有校验标记时，种子文件丢失、损坏或被替换均拒绝启动，不静默生成新身份。旧版只存在种子文件时原样复用并补标记。整个卷或两份身份文件都被直接删除后无法判断旧身份，必须通过备份恢复。

- 正常停止、浏览器容器重建、槽位「保留数据」重建：保留 profile 与浏览器种子。
- 槽位删除、明确「重建新特征」：在原操作通过门禁后清理整个 profile 卷及种子，下次启动获得新浏览器身份。删除槽位被拒绝时不清空 profile。
- 管理员可以在浏览器窗口点「重置浏览器登录态」，二次确认后清空 Cookie、网站存储、书签、历史、标签页与下载文件，**保留浏览器种子和校验标记、不改 API 凭证**。清理由固定的临时容器完成，仅挂载该 profile，无网络、无 capabilities，以 UID 1000 运行；失败会报错。
- profile 卷标记创建时属主和 guest machine ID。身份改变后拒绝复用旧登录态，需管理员明确重置；此时清理整个旧卷及种子，新属主不会继承前任用户的会话或指纹。
- 不自动跨节点同步 profile。移动槽位前关闭浏览器；旧节点命名卷不会自动复制或删除，需在批准的数据迁移/清理中处理。不要让两个节点同时写同一 profile。

当前 vm2api 备份和单槽导出**不包含浏览器命名卷**。要保留网页登录态，必须在浏览器停止后对这个卷做额外备份，排除临时锁、缓存可节省空间；备份按凭证保护并加密存放，不提交仓库、不传到不可信服务。恢复时确认对应槽位、属主和机器身份；浏览器 keyring/站点规则可能要求重新登录，不能承诺跨系统 profile 可移植。未另做备份时可重新网页登录，API 凭证不受影响。

## 验证

源码/离线契约：

```bash
node --test test/unit/slot-browser-*.test.mjs
python3 -m unittest discover -s test/deploy -p test_slot_browser.py -v
pnpm -C web exec vitest run src/features/vm/slot-browser-panel.test.tsx
pnpm -C web typecheck
```

实际容器网络验收在专用随机名称的测试网桥上运行真实 kin-egress、离线 SOCKS5/DNS/HTTP fixture 与两份 Chromium。fixture 不转发 Internet；不使用真实账号、代理或供应商额度。测试期间需要 Docker 管理权限；只为测试网桥安装规则，finally 停浏览器后移除测试规则/容器/卷。

同时检查两槽 Canvas/Audio 差异、重复采样和 Worker 一致性、重启保留身份/登录态、清理登录态保留身份，以及完整删除后生成新身份。Docker 默认地址池耗尽时，可用 `KIN_BROWSER_SMOKE_SUBNET=10.253.253.0/24` 指定已确认空闲的测试子网；不要为此清理已有业务网络。

```bash
mkdir -p .local/slot-browser-test
# GOARCH 与 Docker Server 架构一致：amd64 或 arm64。
(cd worker && GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build \
  -o ../.local/slot-browser-test/kin-egress ./cmd/kin-egress)
KIN_BROWSER_SMOKE_EGRESS="$PWD/.local/slot-browser-test/kin-egress" \
  node test/deploy/smoke_slot_browser.mjs
```

可选 UI 验收使用已经安装的 Playwright 和浏览器，不自动下载安装：

```bash
KIN_BROWSER_SMOKE_EGRESS="$PWD/.local/slot-browser-test/kin-egress" \
PLAYWRIGHT_MODULE=/absolute/path/to/playwright \
BROWSER_EXECUTABLE=/absolute/path/to/chrome \
  node test/deploy/smoke_slot_browser_ui.mjs
```

UI 验收加载真实 React 组件、service 与 Docker/RFB 链路，模拟 Panel 身份和 OAuth 换票端点；另有真实 Panel 路由门禁和 session 撤销单测。截图写入 `.local/slot-browser-test/`。这不等于真实 Claude/Codex 登录或线上 SSH 节点验收。

### 本轮验证记录（2026-11-01）

开发基线 `e399426b53100f7addfbabb68a376b127e953c4f`，分支 `fork/slot-browser` 的未提交工作区；以下是本轮实际执行结果，不是基线 CI 结果。

- 新增 Node 专项 **24/24**；Linux Node 22 容器中新增与受影响的 Panel、OAuth、终端回归合计 **85/85**，无跳过。
- Python 离线契约 **4/4**；前端相关测试 **30/30**；改动前端文件 ESLint、TypeScript 和生产构建通过。
- 主动 LSP 检查 23 个文件无 error；`panel-routes.mjs` 超过 LSP 行数限制，使用 Node 语法检查及上述实际路由测试验证，不宣称其全量 LSP 已通过。
- `linux/arm64` 实际镜像：`sha256:fd40e1782960472649aa7290312f6eb73e714c17b5a2741b6876ffe84be3f0e1`，Chromium `156.0.8078.73`。两槽真实浏览器的存储/语言/时区/RFB/权限隔离、DNS 经代理、WebRTC、UDP/IPv6/内网阻断、代理失效无 TCP/DNS 回退、断心跳独立 lease 停止均通过。
- 实际 React/noVNC 画面、键盘/鼠标、中文剪贴板、390px 窄屏标题与关闭控件、模拟 Codex 回调通过；page error 和页面 console error 检查通过。本机测试使用 HTTP/WS，不冒充生产 TLS/WSS 验收。
- Mac 原生回归最初有一条旧终端测试无法读取 Linux CPU 核数；在未改的同基线复现。Linux Node 22 下该测试通过，未修改它的断言。

未运行真实账号登录、供应商换票/推理、amd64 浏览器容器、真实远程 SSH 节点或线上部署。临时测试容器/卷/网桥已清理，镜像和 `.local/slot-browser-test/` 中的截图、测试二进制保留。上线前需在目标架构和节点重复容器验收，再由用户进行真实登录。

### 代理池时区修复验证（同日后续）

- 旧行为现场：代理实际出口已返回 `Asia/Tokyo`，但池 geo 缓存、槽位和浏览器仍为 `Asia/Hong_Kong`；跟随开关已开且非手动时区。只读查询确认后才修复，没有手工写死东京时区。
- 新增核心回归在修复前 5/5 失败；修复后在宿主与实际 `linux/amd64` 控制面镜像的 Node 22 上，受影响后端合计 **114/114** 通过。前端相关 **22/22**、ESLint/TypeScript/构建、12 个文件主动 LSP 检查通过；大 Panel 路由采用语法及实际路由测试。
- 真实 noVNC 测试验证了变更停止、4001 原因提示、手动重开以及既有键鼠/剪贴板/回调无回归。测试服务器与生产构建先后执行，避免构建输出触发开发服务器页面刷新。
- 本地 `18788` 已换为源码快照 `09f13e84d8db7ec6c171793a4172543781654ab2be9ed16c244c49f41887a103` 的开发预览；实际新开浏览器、槽位记录和面板均为 `Asia/Tokyo`，公共 HTTPS 200、DNS 正常，页面无 error。profile 卷身份、代理/调度/凭证元数据保留；更新前有 SQLite 一致性备份及 profile 备份，均在 `.local/docker-preview/timezone-20261101T120956Z/`。
- 只更新本机，没有部署线上，也没有自动切换用户代理、登录真实账号或发送推理请求。没有重跑未改变的浏览器镜像完整防漏验收。

### Chromix 接入验证（2026-11-12）

开发基线 `97068cd361e175723e3a4f14f5769b8634970963`，隔离 worktree `../vm2api-slot-browser-fingerprint`，分支 `fork/slot-browser-fingerprint` 的未提交工作区。以下是本地开发结果，尚未推送或取得本次 CI 结果，也未切换线上。

- Node 槽位浏览器专项 **37/37**，Python 契约 **9/9**；前端相关 **3/3**、TypeScript、修改组件的 ESLint/Prettier 与后端修改文件的格式检查通过。
- 原生 `linux/arm64` 从本次 Dockerfile 完整构建并实际运行：两槽独立网站数据、不同 Canvas/Audio、重复读值/Canvas 裁剪/Worker 一致性、重启保留身份和登录态、清理登录态保留身份、完整删除生成新身份通过。额外检查了 Chrome 子进程具有比容器入口更多的 seccomp 过滤器。
- RFB、UID/capabilities、语言/时区/屏幕/请求头、代理 DNS、WebRTC、内网/元数据/IPv6/非 DNS UDP 阻断、代理失效无直连回退，以及断心跳独立停止通过。实际 React/noVNC、键鼠、中文剪贴板、窄屏和模拟 OAuth 回调通过。
- 用原版 `:1` Chromium `156.0.8078.73` 生成的合成 profile 升级到 Chromix `156.0.8078.79`，Cookie/LocalStorage 保留并新增首次身份文件。没有测试真实账号迁移或供应商登录。
- `linux/amd64` 完整镜像构建及 `--version` 通过；本机 ARM 的 x86 模拟运行在内部 seccomp 检查处失败，不算该架构完整通过。同一个独立最小 BPF 程序在原生 ARM 上成功增加过滤器，在 x86 模拟环境返回 `EINVAL`。已增加启动时架构匹配门禁；**原生 amd64 Linux/CI 的完整验收仍待执行，上线前必须通过**。

本次测试镜像的本地 Docker inspect image ID：

| 平台 | 镜像 | ID |
| --- | --- | --- |
| linux/arm64 | `local/vm2api-slot-browser:2` | `sha256:b97ba3b099fd89ab4283948bbc639c2a7fd9afcc26a9be682f8e6a66a1436ec2` |
| linux/amd64 | `local/vm2api-slot-browser:2-amd64` | `sha256:03604344a0595b0be5c83dc90319b91934d05d1cc6ee1a79fe3e3b49d3a5d2c9` |

日志、合成迁移/沙箱诊断脚本及 UI 截图保存在本 worktree 的 `.local/slot-browser-test/`，不进入产品镜像或源码提交。它们不替代目标节点、真实远程 SSH 或生产 TLS/WSS 验收；固定种子也不构成网站无法关联账号的保证。

### 日常浏览扩展初轮验证（2026-11-13，权限受限）

基线 `25d562050fd148e6fc732897a165cc64ad686e61`，独立 worktree `/private/tmp/vm2api-persistent-slot-browser`，分支 `fork/persistent-slot-browser`。原工作区未修改；以下均为本地结果，没有本次 CI 或线上部署结果。

- 不监听端口的 Node 专项 19 项通过，包含真实 service handler 的普通重连不导航、显式授权链接及手动停止保留资料检查；Python 浏览器契约 11 项、切换脚本契约 10 项、前端相关 10 项通过。
- TypeScript、前端生产构建、修改文件的 Biome/Prettier 与 Python 语法检查通过。复用了本机已有依赖，包括另一个工作区已安装的同版本 noVNC 1.7.0，未修改依赖清单或下载新包。
- 修改的前端文件 ESLint 只有 `claude-login.tsx` 原有的 `no-control-regex` 报错；在未改的基线内容上复现，未将它算作通过，也未改认证路径校验规则。
- HTTP/WebSocket 与 Docker 模拟服务测试因本会话禁止监听 `127.0.0.1` 而报 `EPERM`；未修改的基线测试同样失败。新增普通打开场景通过直接调用真实 handler 验证，不能替代网络链路验收。
- Docker socket 同样被本会话权限拒绝。本次未构建 `:3` 镜像，未运行真实容器、noVNC 画面、供应商登录、推理或部署。容器 smoke 已补上标签恢复、重启设备特征、语言/时区变化保持种子及手动停止检查，须在有权限的原生架构节点执行后再验收上线。

### 开放权限后的容器与 UI 验收（2026-11-13）

同一 worktree 和基线的未提交验证快照，没有提交、推送或线上切换。权限开放后，本机 Docker Desktop 一度显示运行但引擎超时返回 500；恢复引擎后确认无运行容器，再执行隔离测试。

- Node 槽位浏览器专项 **38/38** 通过，无跳过，包含真实 HTTP/WebSocket。移除了初轮为免监听验证添加的临时 handler 直调模式；普通重连不导航的新增场景现已通过真实 HTTP 验证。
- 从当前 Dockerfile 构建并验收 **原生 linux/arm64** 镜像，实际版本 `Chromium 156.0.8078.79`、标记 `chromix-2`。临时 tag 为 `local/vm2api-slot-browser:3-acceptance-20261113`，Docker inspect ID 为 `sha256:ad58224704a8dbbe0a12b7f43bdfda29f7f85384f73d7285a8a021feafcabe9c`。这是未提交源码的本地验证工件，不是正式发布身份。
- 真实双容器验收通过：独立网站数据、Canvas/Audio 差异及同槽稳定性、Worker 一致性、停止后恢复标签页、设备呈现与种子不变；槽位语言/时区更新后继承新环境且不重抽身份；清理登录态保留身份、完整删除生成新身份。
- UID/capabilities、Chromium 附加 sandbox seccomp、RFB、DNS 经代理、WebRTC、宿主/其他容器/元数据/IPv6/非 DNS UDP 阻断、代理失效无 TCP/DNS 直连回退，以及断心跳后独立 lease 停止均通过。
- HTTP fixture 的 `deviceMemory` 按安全上下文可见性检查。另用产品实际运行的有头浏览器访问容器内 localhost，实测 `isSecureContext=true`、CPU 8、内存 8。最初额外 headless `--dump-dom` 探针超时，不算通过；最终验证使用产品有头进程，没有改变产品 sandbox 或公开控制端口。
- 真实 React/noVNC UI 通过：日常入口重连不新增供应商标签、环境标识不变、键鼠、中文剪贴板、390px 窄屏布局、顶部手动停止后重开、环境失效提示，以及 Codex 模拟回调仅提交一次。Claude 原生 CC 弹窗内打开槽位浏览器、确认远端窗口切到 Claude 域名、关闭画面后回填合成授权码到原终端的衔接也通过。页面与 GUI 控制台 error 检查通过。
- 修正了 UI 测试服务器首次依赖预构建触发自动刷新、504 的测试干扰：固定扫描入口、noVNC 解析和独立缓存后重跑通过。没有改产品依赖或放宽错误断言。
- 测试容器、profile 卷和网桥全部清理；测试前后网络均为 **34**，原有容器保留，测试后运行容器为 0。镜像、日志、截图和逐文件源码摘要保留在 `.local/slot-browser-test/`：`validation-20261113.json`、`unit-20261113.log`、`container-20261113.log`、`ui-20261113.log`、`secure-device-20261113.log`。

未运行原生 amd64、真实供应商账号登录/推理、远程 SSH 节点、生产 HTTPS/WSS 或线上部署。模拟授权不等于真实供应商登录通过；生产 amd64 仍须在目标节点或 CI 完成同样验收。
