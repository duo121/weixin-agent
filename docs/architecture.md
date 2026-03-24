# weixin-agent 架构分层图

## 1. 目标

`weixin-agent` 的目标不是再启动一个独立的 Codex 后端，而是把微信接入到**一个全局 router 和多个本地 AI 终端会话**。

目标体验：

```text
本地 AI 终端会话 A ----\
本地 AI 终端会话 B -----+-> weixin-agent router -> 微信回复
本地 AI 终端会话 C ----/
           ^
           |
        微信输入
```

这意味着：

- 真正执行任务的是一个或多个本地 AI 终端会话
- `weixin-agent` 是 router / bridge 控制器，不是另一个独立 AI
- 微信和本地终端共享的是同一个本地 agent 体系，而不是单独再起一个后端

## 2. 不做什么

`weixin-agent` 不应直接照搬下面两种模式：

### 2.1 不照搬 `weixin-agent-sdk-main` 的最终产品形态

原项目更偏向：

```text
微信 -> bridge -> Agent.chat() -> 一次性回复
```

或者：

```text
微信 -> weixin-acp -> codex-acp -> 独立 Codex 会话
```

这不符合当前目标，因为我们要的是“当前这条 Codex 会话”，不是“另起一个新的 Codex”。

### 2.2 不照搬 `termhub` 的业务目标

`termhub` 的价值在于：

- AI-native CLI 契约
- `spec`
- `doctor`
- JSON 输出
- 明确的工作流

但 `weixin-agent` 不是 terminal controller，不需要复制它的命令语义或业务边界。

## 3. 参考关系

### 3.1 从 `weixin-agent-sdk-main` 参考什么

只参考它的**微信传输层能力**：

- 二维码登录
- 微信消息拉取
- 媒体下载与解密
- 微信消息回发
- 状态持久化

不直接继承的部分：

- `Agent.chat()` 作为最终产品边界
- `weixin-acp start -- codex-acp` 的独立子进程模型

### 3.2 从 `termhub` 参考什么

只参考它的**AI-native CLI 风格**：

- 稳定命令树
- `spec` 机器契约
- `doctor` 环境诊断
- `status`/`dry-run`
- 全量 JSON 输出

不直接继承的部分：

- terminal automation 的具体目标
- 具体命令集合

## 4. 三层架构

`weixin-agent` 应按三层来设计。

### 4.1 第一层：WeChat Transport Layer

职责：

- 登录微信 bot 通道
- 长轮询消息
- 下载媒体
- 回发消息
- 维护本地 token / account / sync buf

来源：

- 主要复用 `../weixin-agent-sdk-main`

这一层回答的问题是：

> 微信怎么进来，怎么回去？

### 4.2 第二层：Router Runtime Layer

职责：

- 接收微信消息
- 维护在线 agent registry
- 按 `@agent-name` 或默认规则选择目标 agent
- 把消息注入到目标 terminal session
- 在 agent 级别维护 ticket / busy 状态
- 回传到微信

这一层是整个项目最核心、最独有的部分。

这一层回答的问题是：

> 微信怎么路由到“某一个本地 AI 终端会话”？

### 4.3 第三层：AI-native CLI Layer

职责：

- 对人和 AI 提供统一命令入口
- 提供 `spec`
- 提供 `doctor`
- 提供 `status`
- 提供 `start`
- 提供 `connect`
- 提供 `events tail`

来源：

- 设计风格参考 `termhub`

这一层回答的问题是：

> 这个系统如何被稳定地启动、诊断、观测和控制？

## 5. 当前主实现：多 Agent Router

```text
WeChat User
  |
  v
WeChat / iLink Bot Channel
  |
  v
weixin-agent router daemon
  |
  +--> connected agent session A
  +--> connected agent session B
  \--> connected agent session C
```

输出回路：

```text
connected agent session
  | \
  |  \-> local terminal render
  |
  \----> run `weixin-agent reply --ticket ...`
           |
           v
         WeChat reply
```

当前主路径命令：

```text
weixin-agent start
weixin-agent connect --session <termhub-handle>
...
weixin-agent reply --ticket <ticket-id> --stdin
```

这已经是当前主实现。

## 6. 当前多 Agent Router 规则

当前 `weixin-agent` 已经按“一个全局 router + 多个已连接 agent”来实现。

目标系统图：

```text
WeChat User
  |
  v
weixin-agent router daemon
  |
  +--> agent registry
  |      +--> codex session A
  |      +--> codex session B
  |      +--> claude session C
  |
  \--> ticket router / reply router
```

关键点：

- `weixin-agent` 可以单独启动，此时允许 0 个连接
- 微信 long-poll 只能由一个全局 router daemon 持有
- 每个终端 AI 只是向 router 注册自己，不再各自拉微信
- 消息路由按 agent 维度进行，不再是“整个系统只能有一个 pending ticket”
- 用户级默认配置写入 `~/.weixin-agent/config.json`
- 微信历史统一追加到账号级 `~/.weixin-agent/history/<account>.jsonl`，每一行都带 `conversationId`

### 6.1 命令语义要区分

命令层应拆成两类：

```text
weixin-agent start
weixin-agent stop
weixin-agent status

weixin-agent connect --session <id|handle>
weixin-agent disconnect --session <id|handle>
weixin-agent agents list
weixin-agent self rename --name <name>
```

语义：

- `start` 只负责启动全局 router daemon
- `start` 允许 0 个连接
- 如果 `start` 后收到微信消息时仍然是 0 个在线 agent，router 可以先自动拉起一个默认 agent 再继续路由
- `connect --session ...` 才表示某个 Codex / Claude / 其他智能体会话接入 router
- `spawn` 用于新开一个终端、启动 `codex` / `claude`，并把这个新终端接入 router
- `disconnect` 只移除某个 agent 连接，不等于关闭 router
- `stop` 才表示停止整个 router

### 6.2 微信侧路由规则

- 0 个在线 agent：先尝试自动拉起一个默认 agent
- 自动拉起成功：继续把这条微信消息路由给新 agent
- 自动拉起失败：回复“当前没有在线智能体，且自动拉起失败”
- 用户消息以 `@名字` 开头：严格路由给被点名的 agent
- `@` 到不存在的名字：返回可用 agent 列表和正确格式
- 不以 `@名字` 开头：先看这个微信会话最近一次沟通的是哪个 agent
- 最近 agent 仍在线：默认投递给它
- 如果该微信会话还没有最近 agent：回退到“最近连接的在线 agent”
- 如果最近一次同时转给了多个 agent，且还没有形成新的单一最近 agent：提示用户用 `@名字` 明确指定
- 某个 agent 忙碌时，只拒绝该 agent 的新任务，不影响别的 agent
- 如果当前会话最近一次对应的 agent 已离线，router 应优先尝试把同名 agent 重拉起来，再继续路由，而不是静默切给别的在线 agent

这意味着：

- 用户可以继续使用精确的 `@豆包2号`
- 用户也可以不带 `@`，让系统默认延续上一次正在沟通的智能体
- 初次沟通或没有历史时，系统会落到最近连接的那个在线智能体
- 如果此时一个在线智能体都没有，系统会先尝试自动开一个新的默认 Codex 终端

### 6.3 自动拉起默认 Agent

router 的 0-agent auto-spawn 目标是让用户在“后台 router 已启动，但当前没人在线”的情况下，依然能直接从微信打通闭环。

推荐流程：

```text
用户发微信
  -> router 发现 0 个在线 agent
  -> router 按 autoSpawn 配置选择终端 app、启动命令
  -> router 新开一个终端
  -> 终端里启动 codex
  -> weixin-agent 自动把这个新终端 connect 进 router
  -> router 把当前这条微信消息继续注入到新 agent
```

默认约束：

- 自动拉起只发生在 `0` 个在线 agent 的时候
- 默认启动命令来自配置，缺省为 `codex`
- 默认终端 app 来自配置，缺省为 `iTerm2`
- 如果这条微信消息以 `@名字` 开头，那么自动拉起时会优先尝试使用这个名字
- 如果没有显式名字，router 会把这个首个默认 agent 命名为 `元宝一号`
- 如果显式 `@名字` 或当前会话最近一次使用的 agent 名字对应的是一个已知离线 agent，router 应优先按原名字重拉该 agent
- 自动拉起成功后，这个微信会话的后续默认路由就会落到这个新 agent
- 自动拉起失败时，微信侧应看到明确错误，而不是静默丢消息

### 6.4 Agent 自主改名

用户可以在微信里 `@某个智能体`，让它改名字；真正执行改名的是那个智能体自己调用工具。

例如：

```text
用户: @元宝2 你把自己改名成元宝
agent: 先决定一个完整且不冲突的名字，例如 豆包3号
agent: 调用 weixin-agent self rename --name 豆包3号
```

这意味着：

- router 只负责把消息路由给目标 agent
- agent 自己决定是否执行改名命令
- 名字修改成功后，router registry 立即更新

### 6.5 Agent 间转交 Ticket

如果一条未显式 `@` 的微信消息被默认投到最近 agent，但该 agent 发现真正应该处理的是别的智能体，那么不应该由 AI 自己“口头转述”，而应该调用工具做显式 ticket 转交。

当前实现建议使用：

```text
weixin-agent transfer --ticket <ticket-id> --to "豆包2号"
weixin-agent transfer --ticket <ticket-id> --to "豆包1号,豆包2号"
```

规则：

- `transfer` 只能由当前持有该 ticket 的 agent 终端调用
- 单目标转交成功后，这个微信会话的“最近智能体”会立即更新为目标 agent
- 多目标转交会拆成多个子 ticket，分别注入给各自目标 agent
- 多目标转交后，在某个子 agent 回复之前，这个微信会话的默认目标会进入“多目标歧义”状态，此时应提示用户使用 `@名字`
- 原 ticket 会进入 `transferred` 或 `delegated` 状态，不能再直接 `reply`

### 6.6 回复身份前缀

每一条通过 `weixin-agent reply --ticket ...` 发回微信的消息，都会由工具自动补上智能体身份前缀，例如：

```text
[豆包2号] 我已经看完文档了，结论如下...
```

这样用户不需要依赖模型自己记住身份，也不会在多智能体场景里混淆是谁回复的。

### 6.7 显式命名规则

当前主流程里，除了 `0` 个在线 agent 时 router 自动拉起的首个默认智能体会使用 `元宝一号`，其余名字都必须由用户明确决定；如果用户没有决定，AI 应先追问名字，再执行创建。

规则：

- `connect --name <displayName>` 是强制参数
- `spawn --name <displayName>` 也要求显式名字；只有 router 在 `0` 个在线 agent 时自动拉起首个智能体，可以使用默认名 `元宝一号`
- `rename agent --to <displayName>` 和 `self rename --name <displayName>` 也都必须传完整名字
- 在线 agent 名字必须唯一；如果重名，CLI 直接报错
- 如果用户只说“再开一个智能体”，但没有决定名字，AI 不应该自己补号，而应该先追问用户要叫什么
- 如果用户已经明确给出名字，例如“创建豆包三号”，上层智能体才应执行 `spawn --name 豆包三号`
- 如果当前智能体发现真正应该处理任务的是一个已知但离线的智能体，它应先执行 `recover --name <displayName>`，再决定是否 `transfer`
- `~/.weixin-agent/config.json` 里的 `agentNameTemplate` 仅用于显式命名模板工作流，不再是默认 router 流程的命名前提

示例：

- 已有 `豆包1号`、`豆包2号`
- 用户要求“再开一个豆包”
- 当前 agent 不应自己补成 `豆包3号`，而应先追问用户名字
- 用户回复“就叫豆包3号”，当前 agent 再显式执行 `spawn --name 豆包3号`
- 如果它直接传 `spawn --name 豆包2号`，CLI 应直接拒绝

### 6.5 状态模型

router 应持久化两类状态：

1. router runtime
2. agent registry

其中 agent registry 至少包含：

- `agentId`
- `displayName`
- `nameBase`
- `kind`
- `sessionHandle`
- `connectedAt`
- `lastSeenAt`
- `status`
- `currentTicketId`

## 7. 交互状态机

### 7.1 未登录

- 还没有微信账号状态
- 需要 `account login`

### 7.2 已登录未启动 Router

- 已经扫码成功
- 但还没有启动 router daemon

### 7.3 Router 运行中，0 个连接

- router 已常驻
- 当前没有在线 agent
- 微信消息会收到“暂无在线智能体”

### 7.4 Router 运行中，1 个或多个连接

- 一个或多个 agent 已注册
- 微信消息可以按规则路由给某个 agent

### 7.5 Agent 忙碌中

- 某个 agent 正在处理 ticket
- 该 agent 的新微信任务应收到“忙碌中”

### 7.6 错误态

- 登录失败
- router 启动失败
- session connect 失败
- 微信消息拉取失败
- 指定 agent 路由失败
- 输出回传失败

## 8. 三种接入 Codex 的方案

### 8.1 方案 A：后台偷偷发给另一个 Codex

```text
微信 -> bridge -> 独立 Codex backend
```

优点：

- 简单
- 容易做

缺点：

- 不属于当前终端这条会话
- 用户在终端里看不到完整输入

结论：

- 不符合目标

### 8.2 方案 B：模拟你在终端里打字

```text
微信 -> bridge -> 向当前 Codex terminal tty 注入输入
```

优点：

- 体验最像“微信接管终端 Codex”
- 不要求 Codex TUI 自己支持 remote live sync
- 可以真正进入当前正在显示的这条 TUI 会话

缺点：

- 仍然需要 bridge 自己做单轮串行和结束判定
- 如果 Codex 的 rollout/history 状态异常，输出观测面仍会受影响

结论：

- 这是当前默认实现
- 输入侧已经可以稳定落地

### 7.3 方案 C：后台发到同一个 Codex session

```text
微信 -> bridge -> 当前 Codex session
本地终端 -> 当前 Codex session
```

优点：

- 终端和微信共享同一个上下文
- 不需要键盘模拟
- 更接近可维护的正式方案

缺点：

- 依赖 Codex 暴露可附着或可控的 session 接口
- 当前本机环境里，`codex --remote` 和 fresh thread materialization 都还存在现实限制

结论：

- 仍然是长期正式方向
- 但当前不能作为唯一依赖

## 8. 技术路线

### 8.1 原型版

目标：

- 尽快打通闭环

策略：

- 微信 transport 复用现有能力
- bridge runtime 做单轮锁和事件记录
- 默认使用 terminal tty injection 把微信文本提交进当前 Codex TUI
- 用 Codex `app-server` 读同一 thread，尽量拿到结构化输出

### 8.2 正式版

目标：

- 把微信真正接到当前 Codex session

策略：

- 继续保留 `CODEX_THREAD_ID` 作为当前 session 锚点
- 优先研究真正可用的 shared `app-server` / remote TUI 方案
- 如果 Codex 官方 remote 能稳定 live render，再把输出观测和输入提交都收敛到正式 JSON-RPC 控制面
- 只把 `termhub` 保留在 e2e 黑盒验证位置

## 9. 当前项目目录分工

建议目录职责如下：

```text
weixin-agent/
  src/
    cli.mjs                CLI 入口
    lib/
      spec.mjs             机器契约
      doctor.mjs           环境诊断
      accounts.mjs         账号状态
      login.mjs            二维码登录
      events.mjs           结构化事件流
      runtime.mjs          bridge 运行时状态
```

后续应新增：

```text
src/lib/
  session-discovery.mjs    当前 Codex thread 发现
  codex-app-server.mjs     app-server JSON-RPC 客户端
  codex-session.mjs        current-codex session 控制器
  wechat-api.mjs           WeChat 文本收发 API
  wechat-runtime.mjs       微信长轮询与消息回传
  bridge-service.mjs       bridge daemon 启停与运行
```

## 10. 当前结论

一句话总结：

`weixin-agent` 的正确路线是：

1. 从 `weixin-agent-sdk-main` 复用微信传输层
2. 从 `termhub` 借鉴 AI-native CLI 契约设计
3. 围绕“attach 到当前 Codex session”重写 bridge runtime
4. 当前输入面默认使用 terminal tty injection，保证微信真的进入当前正在显示的 Codex TUI
5. 输出面优先尝试 Codex `app-server`，等待更稳定的正式控制面成熟

而不是：

- 照搬 SDK 项目的产品边界
- 照搬 `termhub` 的业务目标
- 或者继续围绕“spawn 一个新的 `codex-acp`”来设计最终产品

## 11. 当前实现结论

截至当前实现，已经验证了三件关键事实：

1. `weixin-agent` 已经能解析当前 iTerm2 / Terminal 会话，并拿到对应 `tty`
2. 往目标 `tty` 顺序写入“文本”再写入 `\\r`，可以把一条消息真实提交进当前 Codex TUI
3. `weixin-agent` 仍然可以通过 Codex `app-server` 对一个已 materialize 的 thread 做 `thread/resume` + `turn/start`

但也验证出一个重要限制：

- 新开的 Codex thread 不一定总能 materialize 成可恢复的 rollout；当前环境里还能看到 state migration mismatch 的日志告警
- 默认本地 Codex TUI 也不会实时渲染“外部 app-server 写入的 turn”

也就是说，当前最接近目标体验的组合其实是：

```text
微信 -> bridge -> 当前 terminal tty -> 当前正在显示的 Codex TUI
                              \
                               \-> app-server 尝试读取同一 thread 结果
```

这意味着如果你的目标是“手机和终端同时看到同一条活跃会话的实时输入输出”，当前路线已经把输入侧打通，但输出侧还要继续在两条路线里选一条：

- 路线 A：shared remote app-server
  让终端 Codex 从一开始就连到 bridge 管理的 app-server
- 路线 B：terminal-side injection
  输入走 tty，输出也改成 terminal-side 观测或更强的会话代理

其中：

- 路线 A 更正式、更可维护
- 路线 B 更接近你最初想象的“微信接管当前终端 Codex”
- 当前代码默认走的是路线 B 的输入侧实现
