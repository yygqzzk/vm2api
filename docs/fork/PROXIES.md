# 代理配置与验收

代理继续使用统一的 `proxies` 配置、出口 helper 和探测恢复流程，不按节点名、
IP 或端口打补丁。上线步骤与备份、回滚要求见 [DEPLOY.md](DEPLOY.md)。

## 连接与出口契约

- 代理服务器的地址族不等于出口地址族。IPv4 SOCKS 入口也可以提供固定 IPv6 出口；
  显示标签使用已有的 `<节点/出口> | egress-ipv4` / `egress-ipv6` 形式，不能据标签改变路由。
- `domain_forward=true` 表示透明出口按已有 DNS 关联转发域名，由出口解析目标。
  本地转发器的健康检查同样通过 SOCKS5 hostname CONNECT 检测双栈域名，
  不将 IPv6-only 出口强制导向 IPv4 字面地址。
- `domain_forward=false` 保留原有字面地址探测。远程 SOCKS 端点保留既有认证探测；
  本次修复不扩大它们的检测范围。`ipv6_enabled` 策略保持不变。
- IPv6-only 出口不保证能访问 IPv4-only 服务。不通过静默 IPv4/直连回退伪装成功；
  固定出口地址、账号绑定、时区与指纹不因健康检查而换绑。
- 本地转发器必须完成真实 TLS 握手或收到匹配查询 ID 的 DNS-over-TCP 响应，
  仅监听端口、SOCKS 认证或 CONNECT 成功不算出口健康。认证失败不重试其他目标。

## 生产配置基线

- 本机 SOCKS 只监听 loopback 并启用认证；跨公网链路使用带身份校验的加密传输，
  不为排障开放无鉴权代理。各固定出口分别绑定其认证身份与源地址。
- 凭证留在运行环境，配置文件仅管理员可读。支持时使用 systemd `LoadCredential`、
  `DynamicUser` 与已有沙箱；监听低端口只授予必要 capability，不改成 root 常驻。
- IPv6 地址和路由必须持久化。更改网络、防火墙、认证或服务前先记录现场、备份并确认影响；
  不把排障当作统一重写其他代理配置的授权。
- 外部仅开放必要端口；启用或修改主机防火墙前核对 SSH 管理入口及全部合法代理客户端，
  准备回退，避免仅放行 vm2api 而误伤个人客户端。

## 验证与恢复

1. 只读核对池记录、转发器认证/路由、实际监听、服务权限及源地址，日志脱敏。
2. 使用部署版本的 Xray 对现场配置运行 `run -test -config <path>`；
   此检查只验证配置，不代替真实连通性验证。
3. 经每个代理验证实际公网出口，再分别检查 TLS 与 DNS 回包。记录失败、HTTP 错误、
   首包耗时与实际推理是否执行；HTTP 401/403 不能写成模型推理通过。
4. 修复上线后通过原有单条/批量探测或定时探测恢复被误停的代理，
   不直接改数据库强制启用，不清除账号或重建槽位。
5. 重跑普通 IPv4、hostname 模式、IPv6 策略、故障关闭及认证失败回归：

   ```bash
   node --test test/unit/proxy-probe-tunnel.test.mjs \
     test/unit/proxy-ipv6.test.mjs test/unit/proxy-pool-bind.test.mjs \
     test/unit/proxy-pool-update.test.mjs test/unit/panel-api-proxy.test.mjs
   ```

生产切换需单独确认；进程外只读探测通过，不代表运行中的控制面已加载修复。
