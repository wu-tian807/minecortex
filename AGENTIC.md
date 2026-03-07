# AGENTIC.md — MineClaw 当前架构说明

> 这份文档描述的是当前代码已经实现的框架结构，而不是历史设计草稿。
> 关注点是：脑如何运行、能力如何装配、Session 如何持久化、日志与热更新如何工作。

---

## 1. 当前定位

MineClaw 是一个**多脑目录驱动**的 Agent 框架。

- `brains/<id>/` 就是一个完整脑区
- 脑之间通过 `EventBus` 通信
- 每个脑都有自己的队列、Session、Hooks、日志目录
- 配置和持久化数据都落在文件系统中

核心原则：

1. 目录即边界。脑的配置、状态、能力覆盖都能在目录结构中看见。
2. Session 不共享。脑之间可以发事件，但绝不共享同一份 LLM 历史。
3. 运行时能力可热更新，但配置文件以磁盘为准，不依赖配置 watcher。

---

## 2. Brain 运行模型

### 脑的两种实现

| 类型 | 条件 | 用途 |
|------|------|------|
| `ConsciousBrain` | 配了 `models.model` | 有 LLM 的主 Agent Loop |
| `ScriptBrain` | 存在 `brains/<id>/src/index.ts` | 纯脚本脑，无 LLM |

当前调度器会扫描 `brains/` 自动发现脑，并根据目录内容选择实现。

### BaseBrain 统一入口

`BaseBrain` 不再只是抽象基类，它现在负责统一的主入口语义：

- 注册脑自己的 `EventQueue`
- 暴露 `boundEventBus`
- 管 `shutdown/free`
- 在 `run()` 外层安装 brain 级日志上下文
- 子类只需要实现 `runMain()`

这意味着：

- “主 run 的上下文流程”是框架层规则，不再散落在各脑实现里
- `console.*` 在 brain 主循环里能自动继承到正确的 `brainId`

### ConsciousBrain 主循环

ConsciousBrain 的主循环仍然是：

1. 等待事件
2. 合并窗口 `coalesceMs`
3. `drain()` 成一个事件批次
4. 追加成 user 消息
5. 进入 `runAgentLoop()`
6. 如果 LLM 产生 tool calls，则通过 `runToolBatch()` 落盘 pending/result

除此之外，ConsciousBrain 还支持：

- 命令队列 `queueCommand()`
- 当前 turn 中断 `turnAbort`
- handoff 驱动的 `innerLoop` / `steer`

### ScriptBrain

ScriptBrain 只负责：

- `import brains/<id>/src/index.ts`
- 可选执行 `start(ctx)`
- 每轮 drain 后调用 `update(events, ctx)`

它不参与 LLM、tool lifecycle 或 prompt 组装。

---

## 3. 事件系统

### Event 结构

```ts
type EventHandoff = "silent" | "turn" | "innerLoop" | "steer";

interface Event {
  source: string;
  type: string;
  payload: unknown;
  ts: number;
  to?: string;
  priority?: number;
  handoff?: EventHandoff;
}
```

旧的 `silent` / `steer` 布尔心智已经过时，当前统一使用 `handoff`：

- `silent`: 只入队，不触发处理
- `turn`: 默认行为，下一个 turn 处理
- `innerLoop`: 当前事件批次结束后尽快让出
- `steer`: 立即中断当前 turn

### EventQueue

每个脑有独立 `EventQueue`，关键能力：

- `push(event)`
- `drain()`
- `pending()`
- `hasHandoff(handoff)`
- `onSteer(cb)`

### EventBusAPI

脑内部和工具看到的是 `boundEventBus`：

```ts
interface EventBusAPI {
  emit(event: Event): void;
  emitToSelf(event: Event): void;
  observe(handler: (event: Event) => void): () => void;
}
```

注意：

- `emit()` 走全局路由
- `emitToSelf()` 直接入本脑队列
- `observe()` 是近期引入的重要能力，用于 renderer/recorder 之类的旁路观察

---

## 4. 配置与文件真相

### 配置分层

当前配置来源分成三层：

1. `minecortex.json`
2. `brains/<id>/brain.json`
3. `key/llm_key.json` 与 `key/models.json`

其中：

- `brain.json` 覆盖全局模型配置
- `llm_key.json` 负责模型到 provider section 的映射
- `models.json` 提供 `ModelSpec`

### 当前配置读取原则

配置文件现在按“磁盘即真相”处理：

- provider 每次创建时都重新读取 `key/llm_key.json`
- `getModelSpec()` 每次都会重新读取 `key/models.json`
- 不再依赖 watcher 才能生效

因此配置变更的正确心智是：

- 配置：按需读取
- 运行态状态：内存同步 + 持久化

### `showThinking`

当前默认值已经统一到“开”：

- `resolveModelParams()` 中默认 `showThinking = true`
- 默认模板也显式写出 `showThinking: true`

---

## 5. Session 与 Tool Lifecycle

### Session 指针

每个脑的当前 Session 由 `brains/<id>/session.json` 决定：

```json
{
  "currentSessionId": "s_..."
}
```

这就是当前 active session 的单一事实来源。

### Session 目录

```text
brains/<id>/
├── session.json
└── sessions/
    └── s_<ts>/
        ├── messages.jsonl
        ├── medias/
        └── events.jsonl   # renderer 侧 UI 事件
```

说明：

- `messages.jsonl` 是 LLM 历史
- `medias/` 存大媒体外置文件
- `events.jsonl` 是 renderer 消费的 UI 事件流，不等于 LLM 消息历史

### SessionManager / SessionStore

当前 session 持久化已经拆成两层：

- `SessionManager`: 面向脑与工具生命周期
- `SessionStore`: 负责落盘、锁、原子写、序列化

这次拆分后，session 修复和工具消息对齐也更清晰。

### Tool lifecycle 已稳定

工具调用不再只是“直接拼消息”，而是显式分成：

1. assistant 写出 `toolCalls`
2. `appendToolPendings()`
3. tool 执行
4. `appendToolResult()`

当前 `tool` 消息有明确状态：

- `pending`
- `completed`
- `failed`
- `synthetic`

这也是近期 session 稳定性改造的核心成果之一。

---

## 6. Capability 系统

### 统一选择器

`tools` / `slots` / `subscriptions` 共用同一个选择器模型：

```ts
interface CapabilitySelector {
  global: "all" | "none";
  enable?: string[];
  disable?: string[];
  config?: Record<string, Record<string, unknown>>;
}
```

### 路径重定向

`brain.json.paths` 允许对三类能力目录做重定向：

```ts
interface CapabilityPathRedirects {
  tools?: string;
  slots?: string;
  subscriptions?: string;
}
```

### DynamicRegistry

这是近期重构里最重要的抽象之一：

```ts
interface DynamicRegistry<T> {
  register(key: string, instance: T): void;
  release(key: string): void;
  get(key: string): T | undefined;
  list(): T[];
}
```

对应三个运行时 API：

- `DynamicToolAPI`
- `DynamicSlotAPI`
- `DynamicSubscriptionAPI`

含义是：

- 磁盘能力通过 loader 加载
- 运行时能力通过 dynamic API 注入/释放
- 三套系统现在语义对齐了

### Loader 职责

| Loader | 负责什么 |
|--------|----------|
| `ToolLoader` | `ToolDefinition` 导入、热重载、动态工具并入 |
| `SlotLoader` | slot 模块导入，以及 `soul/directives/skills` 失效 |
| `SubscriptionLoader` | `EventSource` 导入、启动、热重载、动态订阅并入 |

---

## 7. Slot / Prompt 系统

Prompt 组装仍然基于 Slot，但当前要注意两个边界：

1. `soul.md` / `directives/*.md` / `skills/*.md` 的内容语义由对应 slot `.ts` 管理
2. watcher 只是负责让这些 slot 失效，不直接解析 markdown

也就是说：

- `SlotLoader` 监听底层文件变化
- 然后 `invalidateSlot("soul" | "directives" | "skills")`
- 真正重新读取内容的是对应 slot 工厂

这比旧文档里“Scheduler 直接重载 directives”那套说法更准确。

---

## 8. 热更新与 FSWatcher

### 当前应该保留 watcher 的只有两类

1. 运行时状态同步
2. 源码/slot 输入文件热更新

### 当前 watcher 分工

- `BrainBoard.registerFSWatcher()`
  - 监听 `brains/brainboard.json`
  - 解决文件与内存状态同步

- `ToolLoader`
  - 监听 `tools/*.ts` 与 `brains/<id>/tools/*.ts`

- `SlotLoader`
  - 监听 `slots/*.ts`
  - 监听 `directives/*.md` / `skills/*.md` / `soul.md`
  - 文件变化时做 slot invalidation

- `SubscriptionLoader`
  - 监听 `subscriptions/*.ts`

- `Scheduler`
  - 只保留 brain 目录删除监听

### 不再推荐的模式

配置文件热重载 watcher 已不再是推荐方向：

- `brain.json`
- `key/llm_key.json`
- `key/models.json`

这些文件更适合“读取时生效”，而不是依赖 watcher 推送。

---

## 9. 日志体系：Logger 与 console

### 现在的结构

当前日志系统已经改成两层：

1. `Logger`
2. `console` bridge

`Logger` 负责：

- 结构化 level
- 全局 `logs/debug.log`
- per-brain `logs/debug.log`
- per-brain `logs/latest.log`

`console` 现在不再是“旁路输出”，而是通过 bridge 接进 `Logger`：

- `console.log/info/warn/error/debug`
- 自动继承当前 `brainId/turn`
- 依赖 `AsyncLocalStorage`

### 上下文传播

核心能力：

- `runWithLogContext()`
- `getLogContext()`
- `BaseBrain.run()` 安装 brain 根上下文
- turn/command/tool 链路再细化上下文

因此现在在脑、工具、订阅、loader 里写 `console.log(...)`，会自动落到对应脑的日志，而不是只掉进全局日志。

### 使用约定

推荐心智：

- `logger.*`
  - 框架级、生命周期级、错误恢复级日志
  - 显式而稳定

- `console.*`
  - loader 热更新
  - 工具/脚本内部运行信息
  - 临时打点
  - 开发者自然偏好的日志入口

简单说：

- 重要系统语义继续用 `logger`
- 开发侧、局部运行信息可以直接用 `console`

### 日志分层速记

看到一个模块时，先按下面这张表判断：

| 模块层次 | 默认做法 |
|----------|----------|
| `Scheduler` / `BaseBrain` / `ConsciousBrain` | 用 `logger.*` |
| `tools/` / `slots/` / `subscriptions/` / `loaders/` | 用 `console.*` |
| `session` 恢复/修复提示 | 用 `console.warn` |
| `registry` / `context` / 纯 helper | 默认不打日志 |
| `cli` 渲染输出 | `process.stdout.write`，这不是日志 |

补充约束：

- 不要在 `SlotRegistry`、`EventBus` 这类容器/路由层随手加日志
- 不要把 CLI 绘制输出误当成日志系统的一部分
- 如果一条信息代表“系统生命周期、错误恢复、fallback、崩溃”，优先回到 `logger.*`

---

## 10. Tool / Subscription / Script 上下文

### ToolContext

```ts
interface ToolContext {
  brainId: string;
  signal: AbortSignal;
  eventBus: EventBusAPI;
  brainBoard: BrainBoardAPI;
  slot: DynamicSlotAPI;
  tools: DynamicToolAPI;
  subscriptions: DynamicSubscriptionAPI;
  pathManager: PathManagerAPI;
  workspace: string;
  trackBackgroundTask?: (p: Promise<unknown>) => void;
  logger?: Logger;
}
```

重点变化：

- `eventBus` 是 brain-bound facade，不是裸全局 bus
- `tools/subscriptions/slot` 都已切到动态 API
- `logger` 仍然可传，但写 `console.*` 也能正确落日志

### SourceContext

```ts
interface SourceContext {
  brain: BrainContextAPI;
  eventConfig?: Record<string, unknown>;
}
```

订阅源拿到的是整个 `brain` facade，而不是零散字段。

---

## 11. LLM Provider 与 Gemini 路由

### Provider registry

当前 provider 由 `api` 类型显式注册：

- `google-gemini-2`
- `google-gemini-3`
- `anthropic`
- `openai-compatible`
- 其他适配器

### key/llm_key.json

模型与 provider section 的关系由 `llm_key.json` 决定，不再依赖旧兼容别名推断。

当前 Gemini 已拆清：

- Gemini 3 模型走 `google-gemini-3`
- Gemini 2 模型走 `google-gemini-2`

### 跨模型 Session 回放

Gemini 3 对 tool replay 和 `thoughtSignature` 更严格。

当前实现已经支持：

- 保留 Gemini 3 合法签名
- 遇到历史消息没有 Gemini 3 签名时
- 在**消息适配阶段**动态把历史 tool call/result 文本化
- 不修改持久化 session 本身

这是当前 Gemini 兼容策略的关键约束。

---

## 12. Scheduler 负责什么

Scheduler 当前职责很聚焦：

1. 发现 brains
2. 读取配置
3. 构造 loaders / registry / provider / sessionManager
4. 创建 `ConsciousBrain` 或 `ScriptBrain`
5. 启动 run loop
6. 处理脑控制命令与进程信号

Scheduler **不应该**承担：

- slot 内容语义管理
- directives/soul/skills 的实际读取
- 配置文件 watcher 驱动的热更新解释

这些职责已经更清晰地下沉到各自模块里。

---

## 13. 当前目录地图

```text
mineclaw/
├── AGENTIC.md
├── minecortex.json
├── directives/
├── skills/
├── tools/
├── slots/
├── subscriptions/
├── key/
│   ├── llm_key.json
│   ├── llm_key.example.json
│   └── models.json
├── brains/
│   ├── brainboard.json
│   └── <brain>/
│       ├── brain.json
│       ├── soul.md
│       ├── session.json
│       ├── sessions/
│       ├── workspace/
│       ├── logs/
│       ├── tools/
│       ├── slots/
│       ├── subscriptions/
│       ├── directives/
│       ├── skills/
│       └── src/
└── src/
    ├── core/
    ├── context/
    ├── llm/
    ├── loaders/
    ├── session/
    ├── hooks/
    ├── fs/
    ├── cli/
    └── terminal/
```

---

## 14. 开发时的简明约定

1. 改框架语义时，优先改 `src/core/types.ts` 和这份文档，避免概念漂移。
2. 配置文件优先走“读取时生效”，不要先想着给配置挂 watcher。
3. loader/工具/脚本里的运行信息允许直接用 `console.*`。
4. 生命周期、错误恢复、fallback、调度器级事件仍优先用 `logger.*`。
5. 新增能力时，先想它属于 `tool`、`slot` 还是 `subscription`，再决定 loader 和 dynamic API 的接入方式。

---

*文档版本: 2026-03-07*
