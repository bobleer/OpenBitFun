# Relay、账号与远程连接常见问题

[English](FAQ.md) · [运维指南](README.md)

## 需要自己部署服务器吗？

不需要。OpenBitFun 2.0 客户端默认使用官方服务域名 `https://super.openbitfun.com`
（账号设备目录位于 `https://super.openbitfun.com/directory`，见
[`deploy/super/README.md`](../../../deploy/super/README.md)）。在宿主与客户端
登录同一个 OpenBitFun 账号，并保持宿主运行且可连接即可。

| 连接方式 | 使用条件 |
| --- | --- |
| 官方 2.0 服务（OpenBitFun Link） | 登录时可联网且各端登录同一 OpenBitFun 账号；无需部署服务器或配置地址。同一网络下的设备会自动通过 Link 走局域网 P2P 直连，跨网络时自动打洞或经同账号设备 / 服务端中继 |
| 自托管 / 分支部署 | 自行部署 2.0 服务端组件（`deploy/super` 与 `deploy/easytier`）并构建配套客户端，见[分支部署指南](README.md#for-community-developers-and-forks) |
| SSH / Docker 工作区 | 能访问目标环境；不依赖账号登录 |

OpenBitFun 2.0 已下线 1.x 时期的「同一网络」桌面内置 LAN Relay、独立 LAN 监听与局域网配对码，以及 1.x Relay 配对邀请。桌面端与 CLI 宿主登录后开启远控即自动加入账号的 OpenBitFun Link 设备网络，同一局域网设备会自动直连，无需切换模式。聊天机器人沿用各自平台的配置与配对流程。

## 必须使用 GitHub 吗？

新版客户端支持 GitHub 与邮箱验证码登录，具体入口取决于共享身份服务是否启用。
邮箱登录不需要设置密码。这两种方式创建独立账号，即使邮箱相同也不会自动合并。
各设备必须使用相同的登录方式与账号，才能看到同一组设备。

旧客户端或旧服务可能只提供 GitHub 登录。缺少预期入口时，应核对客户端版本与
服务支持情况。本地使用及 SSH / Docker 工作区连接不需要 OpenBitFun 账号；模型和
外部服务的凭据另行配置。

1.x 的 Relay 配对邀请在 2.0 已下线：手机端（OpenBitFun 手机 App）和浏览器
（`https://super.openbitfun.com/`）登录同一 OpenBitFun 账号后，即可通过
OpenBitFun Link 访问账号设备目录中的在线设备。

## 同一网络下的设备能完全离线使用吗？

OpenBitFun 2.0 不再提供独立的局域网模式或桌面内置 LAN Relay。设备登录并加入
OpenBitFun Link 后，处于同一网络时会自动走局域网 P2P 直连，数据不经过服务端中继。
但账号登录仍需通过 `auth.openbitfun.com` 验证身份并在线获取目录与 Link 凭据，
因此不提供离线开户或登录流程；已有会话处于登录状态，也不代表断网后能完成新的登录或凭据续期。

隔离网络中可考虑本地工作或 SSH / Docker，但仍需满足各自的连接与模型运行条件。
仅自建目录与 Link 服务不能去掉在线身份依赖；独立部署还需适配身份服务和客户端。
当前发布版没有开箱即用的隔离网络身份模式。

## 服务能看到什么？

设备控制的传输内容采用端到端加密。各设备在本地生成 X25519 私钥，从已认证的
账号目录获取对端公钥，并在 OpenBitFun Link（以及浏览器网关的 `obp-e2e-v1` 通道）
中基于派生密钥完成认证与加密。设备目录、Link 中继节点和浏览器网关均不接收设备私钥。
会话历史与工作区文件按需从持有它们的在线宿主读取，不在服务端保留会话备份。

托管服务仍会处理账号 ID、设备注册信息、公钥与路由/中继元数据；身份服务负责登录验证。
身份服务与已认证的公钥目录仍在信任边界内。因此，内容加密不能等同于「数据不经过运营服务」，
也不能保护已经被攻破的设备。

已发布的 Pages、Page 数据与函数、市场、模型请求及聊天机器人有各自的数据流。
发布 Page 会按所选可见性规则把内容上传到发布服务。不能把设备控制的加密范围
扩展成对 OpenBitFun 全部网络流量的承诺。

## 官方服务免费吗？有什么额度和 SLA？

仓库记录了技术资源限制，但没有发布价目表、月度流量额度或服务等级协议（SLA）。
依赖具体费用或可用性条款前，请查阅当期服务公告，或通过
[项目仓库](https://github.com/GCWing/OpenBitFun)向维护者核实。开源许可证不能
代替托管服务的运营条款。

[资源限制表](README.md#public-service-resource-controls)列出了设备、连接、
请求与消息大小等限制。这些是技术限制，不是订阅额度或无限使用承诺；实际部署
与反向代理还可能采用更严格的限制。旧 0.2.x「Beta 免费」描述不能作为永久免费
或当前额度的依据。旧匿名配对、密码开户和部署向导说明，也不适用于当前的账号
连接流程。

## 服务或设备不可用时怎么办？

新登录需要身份服务可用；远程控制需要目标宿主保持运行并可通过 OpenBitFun Link
（直连或中继）可达。宿主离线时，无法读取它的会话历史与文件。控制端断开不会取消
已在宿主上运行的任务，但宿主必须继续运行，等待授权的任务也仍需有人回答。

已经登录且处于同一局域网的设备可通过 OpenBitFun Link 走局域网 P2P 直连，但新登录、
浏览器网关访问以及目录/Link 凭据刷新仍依赖托管服务。本地工作与另行配置的 SSH / Docker
访问不依赖账号服务。恢复连接后先检查已有任务，再决定是否重新提交。

## 自托管实际需要做什么？

公开模式使用固定官方端点（`https://super.openbitfun.com`），没有可手填的服务器地址
或部署向导。自托管 2.0 需要统一修改客户端端点、部署 2.0 服务端组件（账号设备目录、
Link 凭据签发服务、Link 中继节点、浏览器网关与 Web 控制器）、配置持久化存储、TLS 和
反向代理，并持续负责备份、升级、监控与容量规划。如果还要自行运营身份服务，
也需配置受支持的登录方式及其回调或邮件发送。购买一台 VPS 并不能完成这些工作，
费用也没有适用于所有部署的固定估算。

请从[分支部署指南](README.md#for-community-developers-and-forks)、
[`deploy/super`](../../../deploy/super/README.md) 与
[`deploy/easytier`](../../../deploy/easytier/README.md) 开始（仅限 1.x 旧版 Relay 部署见
[v1 部署指南](../../../deploy/relay-v1/README.md)）。只修改服务器环境变量
不会改变已发布客户端的连接地址。

## 实现参考

- [统一客户端架构（OpenBitFun Link 与 LAN 下线）](../../../docs/architecture/unified-client-architecture.md#mesh-only-lan-sunset-and-a-domain-only-server)
- [官方端点与账号身份](../../crates/contracts/product-domains/src/account.rs)
- [共享登录及旧客户端兼容](../../crates/services/miniapp-market-service/README.md#邮箱验证码登录)
- [桌面连接生命周期](../desktop/README.md#remote-connect)
- [设备密钥派生](../../crates/services/services-integrations/src/remote_connect/device_crypto.rs)与[Relay 身份验证](../../crates/services/relay-service/src/identity.rs)
- [远程工作区归属](../../../docs/architecture/remote-workspace-transport.md#controller-and-runtime-ownership)
