# AGENTIC.md — MineClaw 框架规范（必读）

> MineClaw 是一个多脑 AI Agent 框架，当前用于通用编程助手场景。
> 未来将扩展为 Minecraft 游戏 AI 的"大脑侧"框架（MineAvatar 是"身体"）。
> 详细设计见 [evolution-design.md](../evolution-design.md)。

---

## 1. 核心信念

**目录即大脑。** 所有状态都在文件系统中，`ls` 可见，`git` 可追溯。

```
brains/       → ls 就知道有哪些脑
skills/       → ls 就知道会什么技能
slots/        → ls 就知道有哪些上下文插槽
tools/        → ls 就知道有哪些工具
```

删目录 = 遗忘。拷目录 = 克隆。`git push` = 灵魂备份。

**多脑并行。** 每个 Brain 是独立的 Agent Loop，拥有自己的 Session、EventQueue、Hooks。
脑之间通过 EventBus 路由消息，绝不共享 LLM Session。

---

## 2. 多脑系统

### Brain = 目录

每个 Brain 是一个自治单元，完整自包含在 `brains/<id>/` 目录中。
**Scheduler 启动时扫描 `brains/` 目录自动发现所有脑区**——不需要中心化注册表。

### brain.json — 脑的完整配置

```jsonc
// brains/coder/brain.json
{
  "models": {
    "model": "claude-opus-4-6",       // 模型名，可以是数组（fallback 链）
    "temperature": 0.7,               // 可选
    "maxTokens": 8192,                // 可选
    "reasoningEffort": "high",        // low/medium/high（推理模型）
    "showThinking": true              // 是否显示思考过程
  },
  "coalesceMs": 300,                  // 事件合并窗口（毫秒）
  "subscriptions": { "global": "none", "enable": ["stdin", "stdout"] },
  "tools": { "global": "all" },
  "slots": { "global": "all" },
  "maxIterations": 200,               // 单次事件处理的最大 LLM 调用次数
  "session": {
    "keepToolResults": 8,             // 微压缩保留最近 N 个 tool_result
    "keepMedias": 2                   // 微压缩保留最近 N 个多媒体消息
  }
}
```

### mineclaw.json — 全局默认配置

```jsonc
// mineclaw.json
{
  "models": {
    "model": "gemini-3.1-pro-preview"  // brain.json 未指定时的 fallback
  }
}
```

### 脑的类型

| 类型 | 条件 | 行为 |
|------|------|------|
| **ConsciousBrain** | 有 `models.model` | Agent Loop：wait → coalesce → drain → process |
| **ScriptBrain** | 有 `brains/<id>/src/index.ts` | 纯脚本驱动，无 LLM |

Scheduler 启动时根据配置自动选择脑类型。

### 脑目录结构

```
brains/<id>/
├── brain.json      # 必须：脑配置
├── soul.md         # 必须：身份/人格/行为准则
├── session.json    # 自动创建：当前 session 指针
├── sessions/       # 自动创建：LLM 会话历史
│   └── s_<ts>/
│       ├── messages.jsonl
│       └── medias/
├── workspace/      # 可选：脑的工作目录
├── logs/           # 可选：脑的日志
├── tools/          # 可选：脑专属工具
├── skills/         # 可选：脑专属技能
├── slots/          # 可选：脑专属插槽
├── subscriptions/  # 可选：脑专属订阅源
└── directives/     # 可选：脑专属指令
```

---

## 3. 事件系统

### Event 结构

```typescript
interface Event {
  source: string;       // 来源：stdin / heartbeat / brain:xxx / tool:xxx
  type: string;         // 类型：message / tick / resume
  payload: unknown;
  ts: number;
  priority?: number;    // 0=immediate, 1=normal(默认), 2=low
  silent?: boolean;     // true = 入队但不触发处理
  steer?: boolean;      // true = 立即中断当前 LLM 调用
}
```

### EventQueue

每个脑拥有独立的 EventQueue，负责：
- `push(event)` — 入队
- `drain()` — 按 priority 排序后批量取出
- `waitForEvent(signal)` — 阻塞等待下一个非 silent 事件
- `hasSteerEvent()` — 检查是否有 steer 事件
- `onSteer(cb)` — 注册 steer 回调（用于中断当前 LLM 调用）

### EventBus — 脑间路由

```typescript
bus.emit(event, sourceBrainId)   // 发送事件，自动路由到目标脑
bus.nudge(brainId)               // 唤醒目标脑（用于命令队列）
bus.register(brainId, queue)     // 注册脑的队列
bus.unregister(brainId)          // 注销
```

跨脑消息通过 `event.payload.to` 字段路由：
- `to: "brain_id"` — 点对点
- `to: "*"` — 广播到所有其他脑

### Agent Loop（ConsciousBrain）

```typescript
while (!signal.aborted) {
  const trigger = await queue.waitForEvent(signal);   // 阻塞等待
  if (!queue.hasSteerEvent() && trigger.priority > 0) {
    await sleep(coalesceMs);                          // 合并窗口
  }
  const events = queue.drain();                       // 批量取出
  await process(events);                              // LLM + tool loop
}
```

**Steer 机制**：当收到 `steer: true` 的事件时，立即中断当前 LLM 调用并处理新事件。

---

## 4. 上下文系统

### Slot — 上下文插槽

System Prompt 由多个 **Slot** 按 `order` 排序后拼接。每个 Slot：

```typescript
interface ContextSlot {
  id: string;                           // 唯一标识
  order: number;                        // 排序权重（小的在前）
  priority: number;                     // 裁剪优先级（低的先被裁）
  condition?: () => boolean;            // 动态条件
  content: string | (() => string);     // 内容（可懒加载）
  version: number;                      // 版本号
}
```

### SlotRegistry

```typescript
registry.registerSlot(slot)   // 注册
registry.removeSlot(id)       // 移除
registry.update(id, content)  // 更新内容
registry.all()                // 获取全部
registry.renderSystem()       // 渲染 System Prompt
```

### 内置 Slots

| Slot | 来源 | 用途 |
|------|------|------|
| `soul` | `brains/<id>/soul.md` | 脑的身份/人格 |
| `directives` | `directives/*.md` | 行为指令 |
| `skills` | `skills/*.md` | 技能摘要列表 |
| `tools` | `tools/*.ts` | 工具描述 |
| `todos` | BrainBoard | 当前任务列表 |
| `context-file` | BrainBoard | 当前关注的文件 |

### Prompt Pipeline

```
1. Resolve  — 懒加载 slot.content()
2. Filter   — 按 condition() 过滤
3. Sort     — 按 order 排序
4. Render   — 变量替换 ${VAR_NAME}
5. Budget   — 按 priority 裁剪超预算的 slot
```

变量来源：BrainBoard 中的键值 + 内置变量（BRAIN_ID, WORKSPACE, CURRENT_TIME）

---

## 5. 能力系统

### CapabilitySelector — 统一的能力选择器

```typescript
interface CapabilitySelector {
  global: "all" | "none";        // 基准
  enable?: string[];             // 额外启用
  disable?: string[];            // 额外禁用
  config?: Record<string, ...>;  // 各能力的配置
}
```

适用于：`subscriptions` / `tools` / `slots`

### 三层能力解析

```
1. 全局能力池（tools/ slots/ subscriptions/）
2. brain.json 选择器过滤
3. 脑内目录覆盖（brains/<id>/tools/ 等）
```

脑内同名 > 全局。

### Loaders

| Loader | 目录 | 产物 |
|--------|------|------|
| ToolLoader | `tools/` | `ToolDefinition[]` |
| SlotLoader | `slots/` | `ContextSlot[]` |
| SubscriptionLoader | `subscriptions/` | `EventSource[]` |

所有 Loader 支持 FSWatcher 热重载。

---

## 6. 订阅源（Subscriptions）

### EventSource 接口

```typescript
interface EventSource {
  name: string;
  start(emit: (event: Event) => void): void;
  stop(): void;
}

type EventSourceFactory = (ctx: SourceContext) => EventSource;
```

### 内置订阅源

| 名称 | 用途 |
|------|------|
| `stdin` | 终端输入，支持 `/command` 解析 |
| `stdout` | 终端输出（LLM 响应流式输出） |
| `heartbeat` | 定时心跳 |
| `auto_compact` | 自动压缩触发器 |

### SourceContext

```typescript
interface SourceContext {
  brainId: string;
  brainDir: string;
  config?: Record<string, unknown>;
  brainBoard: BrainBoardAPI;
  hooks: BrainHooksAPI;
  onCommand?: (toolName, args, target?, reason?) => void;
}
```

---

## 7. 工具系统（Tools）

### ToolDefinition

```typescript
interface ToolDefinition {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: ...; required?: string[] };
  execute: (args, ctx: ToolContext) => Promise<ToolOutput>;
}

type ToolOutput = string | ContentPart[];  // 支持多模态返回
```

### ToolContext

```typescript
interface ToolContext {
  brainId: string;
  signal: AbortSignal;
  emit: (event: Event) => void;
  brainBoard: BrainBoardAPI;
  slot: DynamicSlotAPI;
  pathManager: PathManagerAPI;
  terminalManager: TerminalManagerAPI;
  workspace: string;
  trackBackgroundTask?: (p: Promise<unknown>) => void;
  logger?: Logger;
}
```

### 内置工具

| 工具 | 用途 |
|------|------|
| `read_file` | 读文件，支持图片 |
| `write_file` | 写文件 |
| `edit_file` | 编辑文件（search/replace） |
| `multi_edit` | 批量编辑 |
| `shell` | 执行命令 |
| `grep` | 搜索代码 |
| `glob` | 文件匹配 |
| `list_dir` | 列目录 |
| `spawn_thought` | 派生子 Agent |
| `send_message` | 跨脑消息 |
| `manage_brain` | 脑管理（create/start/stop/free） |
| `todo_write` | 任务管理 |
| `compact` | 会话压缩 |
| `focus` | 设置关注文件 |
| `subscribe` / `unsubscribe` | 动态订阅管理 |
| `read_skill` | 读取技能详情 |
| `web_search` / `web_fetch` | Web 访问 |
| `sleep` | 延时 |
| `lsp` | 语言服务器协议操作 |

---

## 8. Session 与压缩

### SessionManager

```typescript
sessionManager.createSession()           // 创建新 session
sessionManager.loadSession()             // 加载当前 session
sessionManager.appendMessage(msg)        // 追加消息
sessionManager.newSession(initialMsgs)   // 创建新 session 并初始化
sessionManager.resetSession()            // 清空当前 session
```

Session 数据结构：
- `session.json` — 当前 session 指针
- `sessions/<sid>/messages.jsonl` — 消息记录
- `sessions/<sid>/medias/` — 大媒体文件（>50KB 自动外置）

### 三层压缩

| 层 | 时机 | 策略 |
|----|------|------|
| **微压缩** | 每次 LLM 调用前 | 旧 tool_result → `[Previous: used X]` |
| **摘要压缩** | token 超阈值 | LLM/模板生成摘要替换历史 |
| **新建 Session** | 手动/自动 | 保留摘要，清空历史 |

### 多模态支持

```typescript
type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "video"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string };
```

大媒体自动序列化为 `*_ref` 类型，反序列化时按需加载。

---

## 9. Hooks 系统

### HookEvent

```typescript
enum HookEvent {
  AssistantMessage = "assistantMessage",
  TurnStart = "turnStart",
  TurnEnd = "turnEnd",
  ToolCall = "toolCall",
  ToolResult = "toolResult",
  StreamChunk = "streamChunk",
}
```

### BrainHooksAPI

```typescript
interface BrainHooksAPI {
  on<E extends HookEvent>(event: E, cb: (payload) => void): () => void;
}
```

Hooks 用于：
- 订阅源监听 LLM 输出（stdout）
- 自动压缩检测（auto_compact）
- 调试/日志

---

## 10. BrainBoard — 响应式状态注册表

### 接口

```typescript
interface BrainBoardAPI {
  set(brainId, key, value): void;
  get(brainId, key): unknown;
  remove(brainId, key): void;
  removeAll(brainId): void;
  removeByPrefix(prefix): void;
  getAll(brainId): Record<string, unknown>;
  brainIds(): string[];
  watch(brainId, key, cb): () => void;
  loadFromDisk(): void;
  registerFSWatcher(watcher): void;
}
```

### 用途

- 存储脑的运行时状态（todos, currentContextUsage, focusFiles 等）
- 跨脑状态共享（任何脑可读其他脑的状态）
- 持久化到 `brains/brainboard.json`
- 支持 FSWatcher 热重载

---

## 11. LLM Provider 系统

### 适配器注册

```typescript
registerProvider("google-generative-ai", (opts) => new GeminiProvider(opts));
registerProvider("anthropic", (opts) => new AnthropicProvider(opts));
registerProvider("openai-compatible", (opts) => new OpenAICompatProvider(opts));
```

### 模型配置

`key/llm_key.json`：
```json
{
  "google": {
    "api_key": "xxx",
    "api": "google-generative-ai",
    "models": ["gemini-2.5-flash", "gemini-3.1-pro-preview"]
  }
}
```

`key/models.json`：
```json
{
  "gemini-2.5-flash": {
    "input": ["text", "image"],
    "reasoning": false,
    "contextWindow": 1000000,
    "maxOutput": 8192,
    "defaultTemperature": 0.7,
    "tokensPerChar": 0.3
  }
}
```

### Fallback 链

```jsonc
// brain.json
{
  "models": {
    "model": ["claude-opus-4-6", "gemini-3.1-pro-preview"]  // 第一个失败自动切换
  }
}
```

---

## 12. Scheduler

### 职责

- 扫描 `brains/` 发现脑
- 初始化各组件（ToolLoader, SlotLoader, SubscriptionLoader, ContextEngine, SessionManager）
- 启动脑的 run loop
- 注册热重载处理器
- 处理信号（Ctrl+C 停止当前脑，再按退出）

### 脑管理 API

```typescript
scheduler.controlBrain("list")                        // 列出活跃脑
scheduler.controlBrain("create", "newbrain", opts)    // 创建
scheduler.controlBrain("start", "brainId")            // 启动
scheduler.controlBrain("stop", "brainId")             // 停止当前调用
scheduler.controlBrain("shutdown", "brainId")         // 完全关闭
scheduler.controlBrain("restart", "brainId")          // 重启
scheduler.controlBrain("free", "brainId")             // 释放（删除目录）
scheduler.controlBrain("resume", "brainId")           // 恢复
```

### 热重载

FSWatcher 监听：
- `brain.json` 变更 → 重载模型配置
- `directives/*.md` → 自动重新渲染
- `skills/*.md` → 自动更新摘要
- `soul.md` → 立即生效

---

## 13. 目录结构

```
mineclaw/
├── AGENTIC.md
├── mineclaw.json              # 全局默认配置
│
│   ── 全局能力池 ──
│
├── subscriptions/             # 事件订阅源
│   ├── stdin.ts
│   ├── stdout.ts
│   ├── heartbeat.ts
│   └── auto_compact.ts
├── tools/                     # 工具定义
│   ├── read_file.ts
│   ├── write_file.ts
│   ├── shell.ts
│   ├── spawn_thought.ts
│   └── ...
├── slots/                     # 上下文插槽
│   ├── soul.ts
│   ├── directives.ts
│   ├── skills.ts
│   ├── tools.ts
│   ├── todos.ts
│   └── context-file.ts
├── skills/                    # 技能库
├── directives/                # 行为指令
│
│   ── 脑区 ──
│
├── brains/
│   ├── brainboard.json        # 响应式状态持久化
│   └── coder/
│       ├── brain.json
│       ├── soul.md
│       ├── session.json
│       ├── sessions/
│       └── workspace/
│
├── key/                       # API 密钥
│   ├── llm_key.json
│   └── models.json
│
└── src/                       # 框架基础设施
    ├── core/                  #   Brain / EventBus / EventQueue / Scheduler
    ├── context/               #   ContextEngine / SlotRegistry / PromptPipeline
    ├── llm/                   #   Provider / 适配器 / 流处理
    ├── loaders/               #   ToolLoader / SlotLoader / SubscriptionLoader
    ├── session/               #   SessionManager / Compaction
    ├── hooks/                 #   BrainHooks
    ├── terminal/              #   TerminalManager
    └── fs/                    #   PathManager / FSWatcher
```

---

## 14. 核心概念速查

| 概念 | 一句话 |
|------|--------|
| **目录即大脑** | `brains/<id>/` = 完整自包含的脑区 |
| **ConsciousBrain** | 有 LLM 的脑，运行 Agent Loop |
| **ScriptBrain** | 纯脚本脑，无 LLM |
| **EventQueue** | 每脑独立的事件队列，支持 steer 中断 |
| **EventBus** | 脑间消息路由 |
| **Slot** | 上下文插槽，动态组装 System Prompt |
| **SlotRegistry** | Slot 的注册表，支持条件加载 |
| **CapabilitySelector** | 统一的能力选择器 (global + enable/disable) |
| **Loader** | 能力加载器，支持热重载 |
| **SessionManager** | Session 管理，支持多模态 |
| **微压缩** | 旧 tool_result → 占位符 |
| **BrainBoard** | 响应式状态注册表，跨脑共享 |
| **Hooks** | 生命周期钩子 (TurnStart/End, ToolCall/Result) |
| **Steer** | 立即中断当前 LLM 调用 |
| **Fallback 链** | 多模型自动切换 |

---

## 15. 文件规范

### 允许的文件类型

`.ts` · `.json` · `.md` · `.jsonl`

**禁止**: `.yaml` · `.toml` · `.env` · `.yml`

### 代码规模

- 单文件 ≤ 300 行
- 函数 ≤ 50 行
- 嵌套 ≤ 3 层

### @desc 注释

每个 `.ts` 文件第一行:

```typescript
// @desc <English, one line, ≤30 tokens>
```

`grep -r @desc src/` 获得全项目地图。

---

## 16. Minecraft 专供设计（TODO）

> 以下是 MineClaw 作为 Minecraft 游戏 AI 框架的核心设计愿景。
> 当前框架已支持基础能力，Minecraft 特有功能待实现。

### 架构：身体与大脑分离

```
MineAvatar (Java)          MineClaw (TypeScript)
    身体                        大脑
     │                           │
     └──── WebSocket JSON ───────┘
           帧率无关协议
```

- **MineAvatar** 不含任何策略，只有执行
- **MineClaw** 不含任何执行，只有决策
- 分界线是 WebSocket JSON — 任何能发 JSON 的系统都能当大脑

### 三速分层

不同层运行在不同时钟频率，互不阻塞：

| 层 | 运行时 | 频率 | 职责 |
|----|--------|------|------|
| 脑层 | TypeScript | 秒~分钟 | 意图/策略/反思 |
| 执行层 | Java | tick 级 (50ms) | BT 遍历/原子动作/事件检测 |

### 五脑初始设计

| Brain | model | src/ | 频率 | 职责 |
|-------|-------|------|------|------|
| **Planner** | — | ✓ | 1~5s | HTN 分解 + GOAP 搜索 + BT 组装 |
| **Executor** | — | ✓ | 事件 | Safety 拼接 + BT 推送 + ActionResult 收集 |
| **Intent** | ✓ | — | 10min | 意图管理 + 目标优先级 + 进化审批 |
| **Social** | ✓ | — | 事件 | 对话回复 + 指令解析 + 社交行为 |
| **Reflect** | ✓ | — | 30min | 失败诊断 + Skill 创作/修改 + 脑区进化 |

**设计原则**：
- Planner/Executor 是纯脚本脑（无 LLM），负责高频低延迟的行为规划
- Intent/Social/Reflect 是意识脑（有 LLM），负责低频高智能的决策
- 以上是初始脑区，不是上限。evolve 模式下可长出新脑

### 行为规划

| 系统 | 用途 |
|------|------|
| **HTN** (Hierarchical Task Network) | 任务分解："获取钻石" → 找矿 → 挖掘 → 收集 |
| **GOAP** (Goal-Oriented Action Planning) | 动态规划：根据当前状态搜索最优行动序列 |
| **BT** (Behavior Tree) | 执行控制：Safety 优先 → 主任务 → fallback |

### Skills（Minecraft 特化）

Skill 不限于一种格式——任何可复用的策略/知识/模板：

| 类型 | 格式 | 例子 |
|------|------|------|
| BT 子树模板 | `.json` | 挖矿行为树、战斗行为树 |
| HTN 策略 | `.md` / `.ts` | "获取钻石"的分解路径 |
| 通用指南 | `.md` | 建筑美学原则、交易策略 |
| GOAP 动作集 | `.ts` | 一组相关动作的 cost 定义 |

### Safety 子树

Safety 不是独立 Brain，而是 BT Root Selector 的最高优先级子树。
每 tick 自动优先检查（血量低→吃→逃）。

### 进化模式

| 手段 | 做什么 | 例子 |
|------|--------|------|
| 改数据文件 | 调参数、改知识 | GOAP cost、HTN 方法 |
| 改 soul.md | 改脑的人格/指令 | 让 Intent 更激进 |
| 写 `src/` | 给脑加脚本能力 | Reflect 给自己写分析工具 |
| 加 `model` | 给脚本脑开意识 | 给 Planner 加 LLM 辅助决策 |
| 新建脑目录 | 长出新脑区 | 创建 `brains/explorer/` |
| 休眠脑 | 停心跳，保留目录 | ROI 低的脑暂停 |

进化操作走 `request_approval` 消息：
ReflectBrain 写 proposal → EventBus 发审批请求 → IntentBrain 审批 → 执行或放弃

### 自然选择

有 LLM 的脑消耗 token。ReflectBrain 定期审计脑区 ROI
（唤醒次数 / 采纳率 / token 消耗）。ROI 过低 → 提议休眠。

---

*文档版本: 2026-03-04*
