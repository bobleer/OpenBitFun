**中文** | [English](AGENTS.md)

# AGENTS-CN.md

OpenBitFun 2.0 由 Rust workspace 与一套共享 NSH UI（`src/nsh-ui`）组成，通过多种宿主交付：原生桌面端（`src/apps/desktop-nsh` 进程内加载 `src/apps/desktop`）、CLI/TUI（`src/apps/cli`）、原生移动端（[`src/apps/mobile-nsh`](src/apps/mobile-nsh/README.md)，iOS/Android；旧版 1.x Kotlin/HarmonyOS 应用留在 [OpenBitFun-Mobile](https://github.com/openBitFun/OpenBitFun-Mobile)）、浏览器（加载设备自带的 NSH Web 包）以及服务端（`src/apps/server`、`src/apps/relay-server`）。桌面端已无 Tauri 运行时，也不再用 WebView 承载主 UI。

仓库核心原则：**先保持产品逻辑平台无关，再通过平台适配层对外暴露能力**。

## 规则在哪里

- 本文件只维护跨模块规则与稳定的仓库级入口。离改动文件最近的 `AGENTS.md` 负责局部边界、crate 清单、surface 命令和 focused 验证；与本文件冲突时，以更近的指南为准。
- `AGENTS.md` 与 `AGENTS-CN.md` 在同一次改动中同步更新。
- 提交与 PR 约定见 [`CONTRIBUTING_CN.md`](CONTRIBUTING_CN.md)。

## 分层

依赖方向自上而下：crate 可以依赖更低层，不得依赖更高层，同层依赖保持最小。各层指南列出该层的 crate 和确切允许的依赖边。下表是物理布局；概念架构（4+1 视图）见 [`docs/architecture/product-architecture.md`](docs/architecture/product-architecture.md)。

| # | 层级 | 路径 | 负责 | 不得 | 指南 |
|---|---|---|---|---|---|
| 1 | 接口与入口层 | `src/apps/*`, `src/nsh-ui`, `src/miniapp-market-web`, `tests/e2e`, `src/crates/interfaces` | 产品宿主、命令、UI 入口、协议接口和跨形态测试 | 保留可复用行为；应下移 | 最近的本地 `AGENTS.md`；[interfaces](src/crates/interfaces/AGENTS.md) |
| 2 | 产品组装层 | `src/crates/assembly` | 兼容导出、产品能力选择、product-full 接线、不可变内置 Agent 内容、adapter/service 注册和生态无关的来源协调 | 实现具体 adapter、OS 或 service 细节 | [AGENTS.md](src/crates/assembly/AGENTS.md) |
| 3 | 适配层 | `src/crates/adapters` | 协议、transport、本地 IPC、WebDriver、AI provider 和外部 AI work source 的 adapter；外部 provider 转换 | 拥有产品能力选择或可复用 OS service 行为 | [AGENTS.md](src/crates/adapters/AGENTS.md) |
| 4 | 服务实现层 | `src/crates/services` | 可复用的 OS、filesystem、terminal、MCP、remote、git、watch、process、network、session persistence 和 MiniApp runtime IO 实现 | 拥有协议/transport 投影或产品能力选择 | [AGENTS.md](src/crates/services/AGENTS.md) |
| 5 | 执行原语层 | `src/crates/execution` | 可移植 Agent Runtime、命名工作流策略、stream、插件运行时客户端、typed-service、tool-contract、tool-group 和 tool-execution 构件 | 拥有宿主专属或交付形态行为 | [AGENTS.md](src/crates/execution/AGENTS.md) |
| 6 | 稳定契约与产品领域层 | `src/crates/contracts` | 跨层共享 DTO、事件形状、runtime port、产品领域契约和策略 | 承载运行时行为或向上依赖 | [AGENTS.md](src/crates/contracts/AGENTS.md) |

- 产品特性只组装用户侧命令、UI contribution、设置和默认策略。长程任务、scheduler、permission、session/workspace、memory、DFX、hook 和 event 事实留在各自既有的 owner。
- 外部系统是边界资源，不是层级。只有已注册的 adapter、service 或 app-local provider 可以调用它们；其他代码消费 port 和稳定契约。

## 前后端分离与 NSH 工程纪律

OpenBitFun 2.0 切换至 NSH，核心目标是降低交互时的 CPU / GPU / 内存占用、提升响应速度与流畅度、保持桌面/移动/浏览器跨端 UI 一致性，并让远控成为同一 OBP 协议下的“又一个前端”。架构设计见 [`docs/architecture/unified-client-architecture.md`](docs/architecture/unified-client-architecture.md) 与 [`docs/architecture/nsh-frontend.md`](docs/architecture/nsh-frontend.md)。

- **前后端严格契约分离**：
  - 原生桌面端（`src/apps/desktop-nsh`）为追求低延迟与低内存，通过 C ABI（`backend_protocol::ffi`）进程内加载 `src/apps/desktop`，但这属于运行期部署形态，而非 Cargo 依赖耦合或内部实现共享。
  - `src/nsh-ui` 只能通过 `src/nsh-ui/src/bridge.ts`（`BackendConnection`：类型化命令 + 带游标/序号的事件流，本地 FFI 与远程 WebSocket/Link 协议完全一致）访问后端，并通过 `WindowShell` / `nsh/*` API 访问本机宿主外壳。前端代码不得直接访问文件系统、本地进程、宿主环境变量或后端内部状态，也不得成为 Rust 编译输入。
  - 后端不得直接操纵 UI 组件或假设本机存在桌面窗口。桌面专属宿主 adapter 放在 `src/apps/desktop` 并经类型化能力接口回流；窗口、托盘、通知、剪贴板和生命周期操作走 `host://shell-request` 通道，无宿主 shell 提供时必须显式拒绝。共享 crate（`src/crates/*`）保持宿主无关（如使用 `openbitfun_events::EventEmitter`）。
- **前端只做展示与交互，状态与逻辑下沉后端**：
  - **后端负责**：业务规则、领域状态、持久化、默认值、校验、能力/权限标记、排序/过滤/计数/分组投影、多步命令编排、文件/Git/连接监听、重连重试循环以及重型数据解析。通过 OBP 输出可直接渲染的 view model 并接收类型化意图（typed intent）。
  - **前端仅负责**：声明式渲染、布局、原生外壳胶水、动画、展示层格式化、逐帧流式文本合并，以及纯瞬态交互状态（未发送草稿、选中态、滚动位置、面板展开/折叠、拖拽几何坐标）。
  - 禁止在前端复制后端规则作为“客户端回退”（会导致桌面、手机、浏览器、CLI、IM Bot 行为漂移），也不要把帧率敏感的高频交互放到同步后端往返后面（远控延迟会直接导致卡顿）。
- **核心逻辑与计算优先用 Rust，TS 严格限定在 NSH UI 层**：
  - 所有领域逻辑、状态机、协议/传输/加密、文件/Git/搜索/进程 IO、数据投影以及 CPU/内存密集型计算全部落在 Rust 后端 crate（`src/crates/*`、`src/apps/desktop`、`src/apps/cli`），避免阻塞 NSH 单线程 JS 运行时并保证全端行为一致。
  - `src/nsh-ui` 中的 TypeScript 严格限于声明式 NSH TSX 视图、signal 绑定、view model 渲染以及薄封装的 `BackendConnection` / `WindowShell` / `ControllerPort` 适配层。
  - NSH 原生 Rust 模块（`src/apps/desktop-nsh/native`、`src/apps/mobile-nsh/native`）只做极薄的 OS/传输桥接（FFI、原生选择器、系统密钥链、Link controller），禁止把产品逻辑写进端侧 native 模块，否则原生桌面、手机、CLI 与浏览器（无法加载端侧 native 模块）会产生分叉。
- **严控前端静态资源与包体预算**：
  - `src/nsh-ui/assets` 下的每个资源都会同步进入桌面安装包、手机安装包、CLI 内嵌 Web UI 包以及浏览器通过 Link/CAS 拉取的远控包，直接放大安装体积、远控冷启动耗时与内存占用。
  - 优先使用 NSH 原生组件、程序化矢量绘制（`<Canvas>` + `Path2D`）、设计 Token 和系统字体，尽量不新增静态资源文件（位图、精灵图、额外字体、vendored JS/CSS 运行时）。
  - 禁止为了“不加文件”而把大体积二进制/图片以 base64 或大字面量内联进 `.ts/.tsx` 源码，这会更严重地拖慢 JS 解析并推高常驻堆内存。
  - 仅在无原生 NSH 或矢量方案可替代时才引入资源或独立渲染器；必须按需懒加载、压缩体积，并由脚本从单一真源同步，禁止跨端手工复制。
- **守住 NSH 渲染与内存预算**：
  - 在 JSX 绑定中通过细粒度 signal 读取状态（NSH 组件只执行一次），长列表必须虚拟化（`<List>`），大载荷按需拉取（例如历史工具输出默认摘要，展开时再按 turn 拉全量，避免把数 MB 数据常驻前端内存）。
  - NSH 原生组件能满足时禁止嵌入 `<WebView>`；定时器、轮询与事件订阅必须在 `cleanup()` 中释放。

## 命令

```bash
pnpm install
pnpm run desktop:dev               # 主要开发循环：构建并运行原生 NSH 桌面应用
pnpm run fmt:rs                    # 修改 Rust 后运行；只格式化已改动 / 已暂存的 .rs 文件
pnpm run check:repo-hygiene        # 仓库内容与文件名规则
pnpm run check:github-config       # GitHub workflow / 配置规则
pnpm run check:core-boundaries     # Cargo feature、依赖方向、模块 owner
```

只有明确需要更大范围格式化时才使用 `cargo fmt`。各 surface、打包及 focused test 命令见最近的指南；完整脚本注册表见 [`package.json`](package.json)。

## 验证

验证范围由 owner 决定，不使用全仓测试矩阵：

1. 运行最近的 `AGENTS.md` 中能覆盖该行为的最窄命令。
2. 优先选择单 package、单 test target 或 module filter，并使用最小 feature。不要把 `product-full`、`all-features` 或 workspace 全量测试当成捷径。
3. 只有对应契约变化时才运行仓库级检查（`check:repo-hygiene`、`check:github-config`、`check:core-boundaries`）。
4. 大范围 build、workspace suite、打包和平台矩阵交给 CI，除非改动影响这些路径或需要复现 CI 故障。

## 每次改动都适用的规则

### 修复 bug

修改 bug 相关代码前，只检查相关的本地代码和本地 Git 历史中是否已有修复，并结合已知的反馈版本和复现条件判断。开始前先说明检查结论。若已有修复，给出对应的代码或提交依据，不要重复实现。

### 后端命令

command 名称使用 `snake_case`，并接收一个结构化 `request`。在 `src/apps/desktop/src/lib.rs` 的 `backend_commands!` 中注册，处理函数前加 `// @backend-command` 标记，运行 `pnpm run desktop-nsh:generate-dispatch`，并在 Product Operation Registry 中补充对应行（见[远程场景](#远程场景)）。TypeScript 包装可以使用 `camelCase`。

```rust
// @backend-command
pub async fn your_command(
    state: State<'_, AppState>,
    request: YourRequest,
) -> Result<YourResponse, String>
```

```ts
await invokeCommand('your_command', { ... }); // 发送 { request: { ... } }
```

### 非交互子进程

- 可能运行在 GUI、无界面、后台或重定向宿主下的非交互子进程（包括可被其他宿主调用的 CLI 模式），不得直接使用裸 `std::process::Command` 或 `tokio::process::Command`。使用 `openbitfun_services_core::process_manager::{create_command, create_tokio_command}` 或该层既有的 facade。
- 确实无法避免直接创建命令时，Windows 代码必须显式设置 `CREATE_NO_WINDOW`，Node 子进程必须设置 `windowsHide: true`。
- 测试 fixture 遵循同样的策略，避免测试时闪现控制台窗口。

### Rust 依赖

- `[workspace.dependencies]` 只统一兼容版本，不提供宽泛的能力并集。每个 crate 只选择自身实际使用的 feature，仅测试所需的 feature 放入 `[dev-dependencies]`，受 feature 控制的服务能力挂在所属 crate 的 feature 上。
- 第三方依赖的默认 feature 若不是所有 consumer 的契约，在 `[workspace.dependencies]` 统一关闭；成员只增加自身需要的切片。
- 仓内 crate 的受保护 `default` 为空时，不在每条依赖边重复写 `default-features = false`。ACP 这类有意保留兼容默认的 crate，窄 consumer 仍需显式关闭。
- 独立 Docker 构建上下文的 manifest 无法继承 workspace 根，必须保留显式版本和默认策略。
- 根 workspace 和 workspace 成员禁止使用 `tokio/full`。
- 细则见 [`docs/architecture/rust-build-dependency-boundaries.md`](docs/architecture/rust-build-dependency-boundaries.md)。修改 manifest 后用 `pnpm run check:core-boundaries` 验证。

### 日志

日志只用英文，且不使用 emoji。前端（`src/nsh-ui`）：见其 [AGENTS.md](src/nsh-ui/AGENTS.md)。后端：[`src/crates/LOGGING.md`](src/crates/LOGGING.md)。

### 国际化

- `src/shared/i18n/contract/locales.json` 统一管理 locale id、alias、fallback 规则和各形态默认语言。修改后运行 `pnpm run i18n:generate`。
- 跨形态稳定标签放在 `src/shared/i18n/resources/shared/<locale>/terms.json`；流程文案留在所属产品形态。
- 任何形态都不得导入其他形态的 locale catalog；静态自包含页面使用生成的 page-scoped shared-term 文件。
- 用户可见的日期、时间和数字使用共享 i18n 格式化 helper，不直接调用 `Intl.*` 或 `toLocale*`。
- 修改 locale 资源或用户可见文案后运行 `pnpm run i18n:audit`（检查 key / 占位符一致性及零增长基线）。
- 细则见 [`docs/architecture/i18n.md`](docs/architecture/i18n.md)。

### 主题与颜色 Token

- 主题与颜色 baseline（`scripts/theme-color-governance-baseline*.json`）是 ratchet 契约，不是可随意修改的测试期望。不得通过提高 baseline、放宽计数、增加宽泛 allowlist 或移除 CI 审计来让失败的审计通过。
- 实际债务减少时同步下调 baseline。确需新增颜色或 key 时，只增加最小 owner contract，并说明现有 semantic、component 或专用域 Token 为什么不能覆盖。
- 修改设计 Token、NSH 主题投影、Web 页面、MiniApp 外观或 CLI/TUI 颜色后，运行 `pnpm run theme:color-audit:all`。
- 细则见 [`docs/architecture/theme-token-optimization.md`](docs/architecture/theme-token-optimization.md)。

### Agent loop

不要把硬编码限制或模式判断作为处理 agent loop 循环问题的第一反应（例如仅按字符串或次数阻止重复工具调用）；这会把 agent loop 变成脆弱的 workflow 引擎。应先定位根因：工具行为、模型交互、会话上下文封装、prompt/tool schema 设计，或状态同步问题。

### 文档与流程产物

- 不要新增或更新 `docs/superpowers/**` 下的文件；`pnpm run check:repo-hygiene` 会拒绝它们。
- 临时计划、设计和实现过程文档仅保留在本地。需要长期维护的架构或功能事实合并到对应的已有文档，用户使用说明放到所属应用的 README。

## 远程场景

工作区、执行这一轮的 runtime、以及正在操作的人，可能分别位于不同机器。下面四种场景是每次改动都要一并覆盖的一等目标，不是事后再补的适配。

产品模型：OpenBitFun 是一个分布式 Agent runtime，只有一个显示与操作界面。
- **Runtime 节点**（桌面端与 CLI）运行 Agent runtime、执行工作，并作为对等的 fleet entry。
- **纯前端客户端**（浏览器、NSH 手机 App、IM Bot）不拥有 runtime，通过一个 fleet entry 操作账号下的任意 runtime；由哪台设备执行只是标签，不是需要切换进入的模式。
- **云端 superagent**（`openbitfun-superagent`）是不拥有工作区 runtime 的控制平面节点（当前 UI 入口在 `src/nsh-ui/src/productGates.ts` 默认关闭；每台设备通过 `superagent.acceptDispatch` 与 `superagent.allowAutoApproval` 控制派发与自动审批）。OpenBitFun 服务器只能通过其域名经 HTTPS 访问。

| 场景 | 含义 | 设计入口 |
|---|---|---|
| 远程工作区 | 工作区位于 SSH 主机、跳板机链路或 Docker 容器；文件、终端、搜索和 Agent 子进程都在那一侧执行 | [remote-workspace-transport.md](docs/architecture/remote-workspace-transport.md)、[remote-workspaces.md](docs/features/remote-workspaces.md) |
| 远程控制 | 纯前端客户端经自动选择并故障切换的 fleet entry 操作所有 runtime：手机走 OpenBitFun Link，浏览器走 HTTPS 网关（`/app/`，端到端加密，运行设备自带 Web UI 包），IM Bot 走设备网 OBP（`mesh_route`，无 relay 回退） | [unified-client-architecture.md](docs/architecture/unified-client-architecture.md)、[services-integrations](src/crates/services/services-integrations/AGENTS.md) 的 `remote_connect` |
| Fleet / 设备上下文 | 产品命令以 `fleet_call {target, command, args}` 路由到所属设备执行，窗口装饰、更新器、账号身份和本机 OS 自动化留在控制端 | [unified-client-architecture.md](docs/architecture/unified-client-architecture.md#fleet-every-runtime-of-the-account-in-one-surface)、[peer-device-mode.md](docs/architecture/peer-device-mode.md) |
| Dispatch 分离任务 | 控制端（桌面、CLI 或云端 superagent）把持久化任务提交到目标宿主后即可断开；目标端拥有 job、session、worktree、事件日志和权限信箱 | [detached-task-dispatch.md](docs/architecture/detached-task-dispatch.md) |

四种场景共同适用的规则：

- **远程路径与功能一起设计。** 默认 UI、进程和文件系统在同一台机器上的能力属于未完成。
- **不支持要显式暴露。** 屏蔽入口或返回明确的不支持状态；静默回落本地、假成功、空载荷和通用错误都算回归，且可能把本地内容泄露给远端控制方。
- **阻塞式交互必须可远程应答。** 权限确认、对话框和选择器必须经既有的 dialog / 权限信箱编排送达当前操作端，避免远程控制和 Dispatch 任务死锁。
- **要能扛断线。** 优先使用可恢复 cursor 和幂等变更，不要依赖“客户端恰好在线”才存在的状态。
- **远程工作区路径在任何客户端 OS 上都是 POSIX 路径。** 不得用宿主 `std::path` 切分或拼接，也不得把控制端路径直接拿到 peer 宿主复用。

各场景的具体约束：

- **远程工作区**：每个已注册的后端命令在 Product Operation Registry（[`remote_surface/table.rs`](src/crates/contracts/product-domains/src/remote_surface/table.rs)）中有且只有一行。新行不得使用 `Unaudited`；删除的命令保留 `retired(...)` 行。修改后运行 `pnpm run capabilities:generate`。见 [remote-surface-contract.md](docs/architecture/remote-surface-contract.md)。
- **Fleet 与设备路由**：被转发且请求携带 session、workspace 或 terminal id 的命令，需要在 [`remote_surface/fleet_routing.rs`](src/crates/contracts/product-domains/src/remote_surface/fleet_routing.rs) 中有一行 `ByOwner`（由 `pnpm run desktop-nsh:check-dispatch` 校验）。必须留在控制端的命令在注册表行中声明为 `ControllerLocal`；桌面端 peer host、CLI peer host 与 `src/nsh-ui/src/generated/peerSurface.ts` 均由此派生拒绝集合（`pnpm run check:core-boundaries` 拒绝手写清单）。CLI 宿主处理的命令需同时具备处理分支与行内 `cli_peer: HANDLED`（由 `src/apps/cli/src/peer_host/commands/mod.rs` 闭包测试校验）。改动 session、account 或 hydrate 路径前先读 [peer-device-mode.md](docs/architecture/peer-device-mode.md)。
- **远程控制（IM Bot）**：Bot 通过 `RemoteCommand`（经 Link 的 `obp_remote_command`）与 bot command router / menu 触达会话。新增或迁移会话级能力时，同步扩展这些入口或返回明确的不支持回复。
- **Dispatch 分离任务**：任务在目标端以 CLI delivery profile 无界面运行，不依赖交互宿主或提交方常驻。新的目标端要求必须通过类型化 capability 协商，不能默认假设。

说明改动在哪些远程场景下验证过；只跑本地测试不能作为远程行为的证据。

## 升级兼容性

用户是原地升级的，远程场景也常把两个不同的 2.0 构建连在同一条链路上。任何改动都必须保证已有安装无需手工修复即可继续工作。

OpenBitFun 2.0 仅在**落盘会话记录与配置**上兼容 1.x（会话、对话记录、工作区、连接配置、设置）。前端、远程控制、peer 与账号不与 1.x 互通，也不使用 1.x relay（`remote.openbitfun.com/relay`、`mobile-web`）。以下跨版本规则适用于 2.0 构建之间：

- **落盘结构向后容错**：新增字段带默认值，反序列化保持容错，绝不重新定义或收窄已有字段语义，也不把旧数据给不出的字段变成必填。
- **绝不以删除或重置用户数据来恢复解析/网络失败**：保留记录、降级功能并给出明确状态。销毁性删除只能是用户的显式操作。
- **跨版本边界通过 capability 协商**：先声明再检查（版本相同不等于行为相同），让旧对端留在可用路径上。
- **改名就是一次迁移**：在所有受支持对端都不再发送旧名称/id/结构前保持兼容读取，并一并迁移引用数据（vault 条目、工作区指针）。
- **用测试证明**：覆盖旧数据反序列化与旧载荷往返，而不只是当前代码写出的数据。

## 修改前必读

在下列范围修改前，先阅读所列文档；子项是硬性约束。

- **`openbitfun-core` 拆解、feature/依赖边界、Rust 构建提速**：[`docs/architecture/product-architecture.md`](docs/architecture/product-architecture.md)、[`docs/architecture/rust-build-dependency-boundaries.md`](docs/architecture/rust-build-dependency-boundaries.md)。
  - 不要把 DTO / contract 抽取误判为 runtime owner 迁移；迁移 runtime owner 必须有评审过的 port/provider 设计、旧路径兼容、行为等价测试，可能改变行为边界时需明确确认。
- **Agent Runtime 部署、多宿主共享 Session 控制、进程拓扑**：[`docs/architecture/agent-runtime-deployment-design.md`](docs/architecture/agent-runtime-deployment-design.md)。
  - Rust Runtime 或 Node/Bun Plugin Host 不得默认按 client、workspace、session 或 plugin 分进程；依据状态归属、执行与安全边界以及实测容量决定。
- **CLI/TUI 能力对齐、非交互输出契约、外部配置导入、白标 CLI**：[`docs/architecture/cli-product-line-design.md`](docs/architecture/cli-product-line-design.md)、[`src/apps/cli/AGENTS.md`](src/apps/cli/AGENTS.md)。
- **HarmonyOS PC CLI/TUI**：[`docs/architecture/platform-portability-design.md`](docs/architecture/platform-portability-design.md) —— 仅作未来目标（真实 PC 系统终端；HAP、`hdc shell`、手机 App 和远端代执行都不能替代）。
- **产品定义、品牌发行、定制构建任务**：[`docs/architecture/product-customization-blueprint.md`](docs/architecture/product-customization-blueprint.md)。
  - 产品定制与用户运行时配置和插件分开；GUI 和 TUI 只共享稳定产品事实，不共享布局、组件、主题键、键位或 renderer schema。组装结果只携带少量不可变产品身份/隔离/恢复/法律项 ID，不承载动态插件状态。
- **OpenCode 实时配置或插件执行**：[`docs/architecture/extensions/opencode-extension-compatibility.md`](docs/architecture/extensions/opencode-extension-compatibility.md)、[`src/crates/adapters/opencode-adapter/AGENTS.md`](src/crates/adapters/opencode-adapter/AGENTS.md)。
  - 不要把兼容目标当成已实现能力，也不要扩张旧的 P0 静态预览受管包路径。
- **Agent Hooks**：[`docs/features/agent-hooks.zh-CN.md`](docs/features/agent-hooks.zh-CN.md)（[English](docs/features/agent-hooks.md)）；引擎与分发归属见 [`agent-runtime`](src/crates/execution/agent-runtime/AGENTS.md) 与 [`core`](src/crates/assembly/core/AGENTS.md)。
  - 原生用户 Hooks 遵循 Codex Hook 契约（<https://learn.chatgpt.com/docs/hooks>），不要另起炉灶，新增或消除差异时同步更新差异表。
- **SDLC Harness（生命周期证据、门禁、Artifact Graph、Project Profile、Deep Review、目标项目治理）**：[`docs/sdlc-harness/README.md`](docs/sdlc-harness/README.md)、[`docs/sdlc-harness/design.md`](docs/sdlc-harness/design.md)。
  - 不要把 OpenBitFun 仓库假设硬编码为目标项目规则；质量保护保持面向目标项目、基于证据、按风险分级、成本可控并可审计。
