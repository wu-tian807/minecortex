# MineCortex 路线图

> 基于当前已完成的 agentic_os 风格 Agent Loop 架构，后续待做事项。
>
> 核心认知：MineCortex Agent 的本质操作和 agentic_os 是同构的——都在管理本地文件系统。
> Agent 不是"直接玩游戏"，而是通过读写 brains/、skills/、src/ 来驱动游戏。
> 因此 agentic_os 的大部分工具能力（文件操作、Shell、搜索）对 MineCortex 同样是刚需，
> 只是驱动范式从"用户对话驱动"变成了"事件驱动"。
>
> agentic_os 的很多独立机制在 MineCortex 的多脑范式下有更统一的抽象：
>
> | agentic_os 操作 | MineCortex 统一抽象 |
> |----------------|-----------------|
> | `switch_persona` | 切换 stdin 订阅到另一个脑（每个脑 = 一个 persona） |
> | `spawn_agent`（有名） | 创建 `brains/<id>/` 目录 + `manage_brain` 启动 |
> | `spawn_agent`（匿名） | `spawn_thought` 工具（Tool + BrainBus） |
> | `agent_status` / `agent_kill` | `manage_brain` list/status/stop |
> | `switch_model` | 编辑 `brain.json` + 重启脑 |
> | `switch_session` | **不映射** — Session 由框架自动维护（三层压缩 + compact 工具），无需手动 reset/new |

---

## 0. 文件系统监听 (fs-watcher)

MineCortex 的核心哲学是"目录即大脑"——所有状态都在文件系统中。
evolve 模式下脑可以修改自身（soul.md、brain.json、skills/、src/），
文件操作工具也会频繁读写 brains/ 目录。这些变更必须**实时生效**，不能靠重启。

### 需求来源

| 场景 | 变更的文件 | 期望行为 |
|------|----------|---------|
| ReflectBrain 修改 soul.md | `brains/reflect/soul.md` | 下次 tick slot:soul 自动用新内容 |
| 通过 edit_file 改 brain.json | `brains/social/brain.json` | Scheduler 感知配置变化，可能需要重启脑 |
| 创建新脑目录 | `brains/explorer/` | Scheduler 自动发现并启动 |
| 新增/修改 Skill | `skills/mine_diamond.md` | skill-loader 重新扫描，slot:skills 更新 |
| 新增/修改 Tool | `tools/navigate.ts` | tool-loader 重新扫描，脑下次 tick 可用新工具 |
| 新增/修改 Directive | `directives/safety.md` | directive-loader 重新扫描 |
| 修改 ScriptBrain 代码 | `brains/planner/src/index.ts` | ScriptBrain 重新加载脚本入口 |
| 删除脑目录 | `brains/explorer/` (rm -rf) | Scheduler 停止并注销该脑 |

### 核心设计

**单一 Watcher，事件分发**：一个 FSWatcher 监听整个项目根目录，
按路径前缀分发给不同的处理器。

```typescript
interface FSChangeEvent {
  type: "create" | "modify" | "delete";
  path: string;       // 相对项目根的路径
  isDir: boolean;
}

interface FSHandler {
  pattern: RegExp;     // 匹配的路径模式
  handle: (event: FSChangeEvent) => void | Promise<void>;
}
```

**处理器注册**：

```
brains/*/brain.json     → Scheduler.onBrainConfigChange()
brains/*/soul.md        → SlotRegistry 标记 slot:soul 需重载
brains/*/skills/*       → SkillLoader.invalidate(brainId)
brains/*/tools/*        → ToolLoader.invalidate(brainId)
brains/*/directives/*   → DirectiveLoader.invalidate(brainId)
brains/*/src/*          → ScriptBrain.reload(brainId)
brains/ (新目录)         → Scheduler.onBrainDiscovered(brainId)
brains/ (删目录)         → Scheduler.onBrainRemoved(brainId)
skills/*                → SkillLoader.invalidateGlobal()
tools/*                 → ToolLoader.invalidateGlobal()
directives/*            → DirectiveLoader.invalidateGlobal()
key/*                   → Provider 重新加载密钥（安全敏感，可选）
```

**防抖**：文件写入可能触发多次 change 事件（write + rename），
每个处理器 debounce 300ms，只处理最后一次。

**与 Slot 系统联动**（§4 完成后）：

文件变更 → Loader invalidate → 下次 assemblePrompt 时 Loader 重新填充对应 Slot。
不需要立即重新加载——**懒加载，tick 时生效**。
Slot 的 `content` 可以是 lazy getter（首次读取时加载，invalidate 后标记为 stale）。

### 需要做的

- **FSWatcher 类**：封装 `node:fs/watch`（recursive），路径过滤 + 防抖 + handler 分发
- **Scheduler 集成**：启动时创建 Watcher，注册 brain 目录变更 handler
- **Loader invalidate 协议**：各 Loader 暴露 `invalidate()` 方法，标记缓存失效
- **debounce 策略**：默认 300ms，brain.json 变更可延长到 1s（防误触）

### 涉及文件

- 新建 `src/core/fs-watcher.ts` — FSWatcher 封装（~80 行）
- `src/core/scheduler.ts` — 创建 Watcher + 注册 handler
- `src/loaders/*.ts` — 各 Loader 新增 `invalidate()` 方法

---

## 1. Session 管理

当前 `sessionHistory` 是纯内存数组，无持久化、无压缩、无上限控制（仅尾部截断到 20 条）。

### 需要做的

- **持久化**：每个脑的 session 写入 `brains/<id>/sessions/` 目录（JSONL 格式），崩溃后可恢复
- **三层压缩**（对齐 AGENTIC.md §5）：
  - 微压缩：旧 tool_result 替换为占位符 `[Previous: used X]`
  - 自动压缩：token 超阈值时用 LLM 生成摘要替换历史
  - 记忆刷写：重要发现写入 `brains/<id>/memory/` 持久化
- **token 预算**：根据 `models.json` 的 `contextWindow` 计算可用 token，动态决定保留多少历史
- **session 隔离**：已有（每脑独立），无需改动

### 涉及文件

- `src/core/brain.ts` — sessionHistory 持久化 + 压缩触发
- 新建 `src/context/session-manager.ts` — 压缩策略 + JSONL 读写
- 新建 `src/context/memory-writer.ts` — 记忆刷写逻辑

---

## 2. 工具发消息与触发

当前 `ctx.emit()` 可以发事件，但缺少便捷的区分机制和文档约定。

### 需要做的

- **明确约定**：工具通过 `ctx.emit()` 发送事件，用 `priority` 和 `silent` 控制行为
  - `priority: 0` + `silent: false`（默认）→ 立即唤醒目标脑
  - `priority: 1` + `silent: true` → 只入队，等下次自然唤醒
- **跨脑消息**：`send_message` 工具已实现（`priority: 0`），消息通过 BrainBus 路由
- **异步回调**：工具内部启动 async 任务，完成后调用 `ctx.emit()` 回传结果（如 `spawn_thought`）
- **自发消息**：工具可以给自己的脑发 silent 事件，作为下次处理时的上下文补充

### 涉及文件

- `tools/send_message.ts` — 已实现，可作为参考
- 新建 `tools/spawn_thought.ts` — 异步子任务工具（回调型 emit 的典型用例）

---

## 3. 动态订阅管理工具

当前订阅在 `brain.json` 中静态配置，运行时无法修改。模型应该能通过工具管理订阅。

### 需要做的

- **`manage_subscription` 工具**：提供 list / add / remove 三个 action
  ```
  manage_subscription({ action: "list" })
  → { subscriptions: ["stdin", "heartbeat"] }

  manage_subscription({ action: "remove", name: "stdin" })
  → { ok: true, removed: "stdin" }

  manage_subscription({ action: "add", target: "creative", name: "stdin" })
  → { ok: true, added: "stdin", target: "creative" }
  ```
- **运行时注册/注销**：Scheduler 或 ToolContext 需要暴露注册/注销 EventSource 的能力
  - `ToolContext` 扩展：`subscribe(source: EventSource): string` / `unsubscribe(id: string): void`
  - 或 Scheduler 暴露一个 `addSource(brainId, source)` / `removeSource(brainId, name)` 方法
- **跨脑操作**：一个脑可以把自己的 stdin 转移给另一个脑（先 remove 自己的，再 add 给对方）
- **持久化**：运行时变更可选写回 `brain.json`，或仅当前 session 生效

### 涉及文件

- 新建 `tools/manage_subscription.ts`
- `src/core/scheduler.ts` — 暴露动态 source 注册/注销接口
- `src/core/types.ts` — ToolContext 扩展（可选）

---

## 4. ContextSlot 化 — 统一的 LLM 上下文管理

当前 `context-engine.ts` 用硬编码拼接 5 层 system prompt，不可扩展。
需要一个统一的抽象来管理 LLM 能看到的一切——system prompt 和 conversation messages 都包含在内。

### 核心设计：两类 Slot

Slot 是 LLM 上下文中的一个**命名区域**。所有 LLM 能看到的内容都是 Slot，分为两类：

**固定槽（System Slot）**：渲染到 system prompt，跨 tick 持久存在。

```
[固定槽] "soul"              order: 0     ← soul.md
[固定槽] "runtime"           order: 10    ← 框架自动生成
[固定槽] "slot_board"        order: 20    ← 派发任务时自动订阅
[固定槽] "tools"             order: 30    ← tool-loader
[固定槽] "directive:*"       order: 40+   ← 指令模块（条件加载）
[固定槽] "skills"            order: 50    ← skill 摘要
[固定槽] "todos"             order: 60    ← 工具可写
[固定槽] "world"             order: 70    ← MineAvatar 快照
```

**增量槽（Message Slot）**：渲染到 conversation messages，本 tick 用完清空。
增量槽对齐 LLM API 的 message 结构，分三种 role：

| 增量槽 role | 对应 LLM message | 约束 | 典型内容 |
|------------|-----------------|------|---------|
| `user` | `{ role: "user" }` | 自由 | stdin 消息、BrainBus 收到的消息、heartbeat 信号 |
| `assistant` | `{ role: "assistant" }` | 后面必须跟 user 或 tool | LLM 上一轮的回复（session history 管理） |
| `tool` | `{ role: "tool", toolCallId }` | 必须紧跟对应的 assistant tool_call | 工具执行结果 |

`tool` 槽是 `assistant` 槽的附属——模型厂商要求 tool message 必须跟在对应的 assistant tool_call 后面，
不能独立存在。这个约束由 SlotRegistry 的渲染逻辑保证。

### 为什么这样分

```
LLM API 要求的 message 结构：
┌─────────────────────────────────────────────┐
│ system: "..."                               │ ← 固定槽渲染
│                                             │
│ messages: [                                 │ ← 增量槽渲染 + session history
│   { role: "user", content: "..." },         │    ← user 增量槽
│   { role: "assistant", content: "...",       │    ← session history
│     tool_calls: [...] },                    │
│   { role: "tool", content: "...",           │    ← tool 增量槽（附属于上面的 assistant）
│     tool_call_id: "..." },                  │
│   { role: "assistant", content: "..." },    │    ← session history
│   { role: "user", content: "..." },         │    ← user 增量槽（本 tick 事件）
│ ]                                           │
└─────────────────────────────────────────────┘
```

固定槽管 system prompt（"你是谁、你能做什么、你在追踪什么"）。
增量槽管 conversation（"刚才发生了什么"），必须遵守 LLM API 的 role 顺序约束。

### 4.1 类型定义

```typescript
type SlotKind = "system" | "user" | "assistant" | "tool";

interface ContextSlot {
  name: string;
  kind: SlotKind;
  order: number;                   // 同 kind 内的排序
  source: "file" | "loader" | "tool" | "framework" | "event-router";
  condition?: (ctx: SlotContext) => boolean;

  content: string | (() => string | Promise<string>);
  entries?: SlotEntry[];           // 复合 slot（slot_board、skills 等）

  // 生命周期
  ephemeral?: boolean;             // true = 渲染后清空（增量槽默认 true）
  stale?: boolean;                 // fs-watcher 标记脏
  ttl?: number;                    // tick 数后过期
}

interface SlotEntry {
  id: string;
  content: string;
  meta?: Record<string, unknown>;
}

// tool 增量槽的额外约束
interface ToolMessageSlot extends ContextSlot {
  kind: "tool";
  toolCallId: string;              // 必须关联到对应的 assistant tool_call
}
```

固定槽（`kind: "system"`）默认 `ephemeral: false`，跨 tick 持久。
增量槽（`kind: "user" | "assistant" | "tool"`）默认 `ephemeral: true`，渲染后清空。

### 4.2 SlotRegistry API

```typescript
class SlotRegistry {
  // --- 基础 CRUD ---
  set(slot: ContextSlot): void;
  get(name: string): ContextSlot | undefined;
  delete(name: string): void;
  has(name: string): boolean;

  // --- 子条目操作（复合 slot）---
  addEntry(slotName: string, entry: SlotEntry): void;
  updateEntry(slotName: string, entryId: string, patch: Partial<SlotEntry>): void;
  removeEntry(slotName: string, entryId: string): void;

  // --- 渲染 ---
  renderSystem(ctx: SlotContext): Promise<string>;         // 固定槽 → system prompt
  renderMessages(ctx: SlotContext): Promise<LLMMessage[]>;  // 增量槽 → message 数组
  flush(): void;                                            // 清空 ephemeral slots

  // --- 运行时 ---
  invalidate(name: string): void;
  invalidateByPattern(pattern: RegExp): void;
  gc(): void;
}
```

**两个渲染入口**，对应 LLM API 的两个部分：

```typescript
// renderSystem: 固定槽 → system prompt 字符串
async renderSystem(ctx: SlotContext): Promise<string> {
  this.gc();
  const systemSlots = this.allByKind("system")
    .filter(s => !s.condition || s.condition(ctx))
    .sort((a, b) => a.order - b.order);

  const parts: string[] = [];
  for (const slot of systemSlots) {
    const text = await this.resolveContent(slot);
    if (text) parts.push(text);
  }
  return parts.join("\n\n");
}

// renderMessages: 增量槽 → LLMMessage[]
async renderMessages(ctx: SlotContext): Promise<LLMMessage[]> {
  const messages: LLMMessage[] = [];

  // user 增量槽：合并为一条 user message
  const userSlots = this.allByKind("user")
    .filter(s => !s.condition || s.condition(ctx))
    .sort((a, b) => a.order - b.order);

  if (userSlots.length > 0) {
    const parts: string[] = [];
    for (const slot of userSlots) {
      const text = await this.resolveContent(slot);
      if (text) parts.push(text);
    }
    messages.push({ role: "user", content: parts.join("\n\n") });
  }

  // tool 增量槽保持独立（每个 toolCallId 一条 message）
  // assistant 增量槽通常由 session history 管理，不在这里渲染

  return messages;
}

// flush: 清空所有 ephemeral slot
flush(): void {
  for (const slot of this.all()) {
    if (slot.ephemeral) {
      if (slot.entries) slot.entries = [];
      else this.delete(slot.name);
    }
  }
}
```

### 4.3 Event Router — 事件到 Slot 的桥梁

EventQueue 是调度层（唤醒 + 合并 + 排序），drain 出来的事件交给 Event Router，
Router 决定每个事件写入哪些 Slot：

```typescript
function routeEvents(events: Event[], registry: SlotRegistry): void {
  for (const event of events) {
    // 所有事件 → user 增量槽（按 source 分组）
    const slotName = `events:${event.source}`;
    if (!registry.has(slotName)) {
      registry.set({
        name: slotName,
        kind: "user",
        order: sourceOrder(event.source),
        source: "event-router",
        ephemeral: true,
        entries: [],
      });
    }
    registry.addEntry(slotName, {
      id: `${event.source}_${event.ts}`,
      content: `[${event.type}] ${renderEventDisplay(event)}`,
    });

    // 特定事件 → 固定槽更新（副作用）
    if (event.source === "bus" && event.payload?.taskId) {
      registry.updateEntry("slot_board", event.payload.taskId, {
        content: `[✓] ${event.payload.summary}`,
        meta: { status: "completed" },
      });
    }
    if (event.source === "world" && event.type === "snapshot") {
      registry.set({
        name: "world", kind: "system", order: 70,
        source: "framework", content: event.payload.snapshot,
      });
    }
  }
}
```

**三层职责**：

```
EventQueue（调度层）
  push → waitForEvent → sleep(coalesce) → drain → Event[]
  不关心内容和渲染

Event Router（路由层）
  Event[] → 写入对应 Slot
  决定"这个事件该进哪些槽"

SlotRegistry（渲染层）
  renderSystem() → system prompt
  renderMessages() → LLMMessage[]
  flush() → 清空增量槽
  不关心事件从哪来
```

### 4.4 brain.ts 中的完整流程

```typescript
async process(events: Event[]) {
  // ① 事件路由到 Slot
  routeEvents(events, this.slotRegistry);

  // ② 渲染固定槽 → system prompt
  const systemPrompt = await this.slotRegistry.renderSystem(ctx);

  // ③ 渲染增量槽 → 本 tick 的 message
  const newMessages = await this.slotRegistry.renderMessages(ctx);

  // ④ 组装完整 messages
  const messages: LLMMessage[] = [
    { role: "system", content: systemPrompt },
    ...this.sessionHistory,
    ...newMessages,
  ];

  // ⑤ LLM 推理 + tool loop
  // （tool loop 中产生的 assistant/tool messages 由 brain.ts 直接管理，
  //   不走 SlotRegistry——它们是实时的对话流，不是 Slot）
  // ...

  // ⑥ 清空增量槽（本 tick 的事件已处理）
  this.slotRegistry.flush();
}
```

### 4.5 固定槽的灵活性

固定槽保留之前设计的全部能力：

**惰性求值 + fs-watcher 联动**：

```typescript
registry.set({
  name: "soul", kind: "system", order: 0, source: "file",
  content: () => readFile(join(brainDir, "soul.md"), "utf-8"),
});
// fs-watcher 变更时 → registry.invalidate("soul") → 下次渲染重新读取
```

**复合 slot（子条目模式）**：

```typescript
// slot_board — 派发任务时自动注册追踪条目
registry.addEntry("slot_board", {
  id: "task_planner_001",
  content: "- [▶ planner] 任务: \"分解挖钻石\" | 执行中",
  meta: { status: "running" },
});
```

**条件渲染**：

```typescript
registry.set({
  name: "directive:combat-rules", kind: "system", order: 43, source: "file",
  content: () => readFile("directives/combat-rules.md", "utf-8"),
  condition: (ctx) => ctx.worldState?.inCombat === true,
});
```

**运行时注册**：

```typescript
ctx.writeSlot("todos", todoContent);
ctx.writeSlot("custom:note", "临时便签...", { ttl: 5 });
```

### 4.6 ToolContext 扩展

```typescript
interface ToolContext {
  brainId: string;
  emit: (event: Event) => void;

  // 固定槽操作（影响下次 tick 的 system prompt）
  readSlot(name: string): string | undefined;
  writeSlot(name: string, content: string, opts?: { ttl?: number }): void;
  addSlotEntry(slotName: string, entry: SlotEntry): void;
  updateSlotEntry(slotName: string, entryId: string, patch: Partial<SlotEntry>): void;
  removeSlotEntry(slotName: string, entryId: string): void;
}
```

工具只操作固定槽。增量槽由 Event Router 和 brain.ts 管理，工具不直接写。

### 4.7 迁移策略

| 当前层 | 迁移为 | 类型 |
|-------|-------|------|
| Layer 1: Soul | `slot:soul` | 固定槽 |
| Layer 2: State | **删除** — 职责分解到 slot_board / session / memory / todos | — |
| Layer 3: Events | 增量槽 `events:stdin`, `events:bus` 等 | user 增量槽 |
| Layer 4: Tools | `slot:tools` | 固定槽 |
| Layer 5: Directives | `slot:directive:*` | 固定槽 |
| 新增 | `slot:runtime` | 固定槽 |
| 新增 | `slot:slot_board` | 固定槽 |
| 新增 | `slot:skills` | 固定槽 |

### 涉及文件

- `src/core/types.ts` — 新增 ContextSlot, SlotEntry, SlotKind, SlotContext
- 新建 `src/context/slot-registry.ts` — SlotRegistry 类
- 新建 `src/context/event-router.ts` — 事件路由到 Slot 的桥梁
- `src/context/context-engine.ts` — 改为调用 `registry.renderSystem()` + `renderMessages()`
- `src/loaders/directive-loader.ts` — 改为固定槽 populator
- `src/loaders/tool-loader.ts` — 改为固定槽 populator
- `src/core/brain.ts` — 持有 SlotRegistry，process() 中调用 Event Router + 渲染 + flush
- `src/core/scheduler.ts` — 初始化时创建 SlotRegistry + 注册初始固定槽

---

## 5. Skills 系统 + readSkill 工具

当前 skills 目录存在但没有加载和使用机制。

### 需要做的

- **Skill 格式**：每个 skill 是一个文件（`.md` / `.json` / `.ts`），包含可复用的知识/策略/模板
- **两层加载**（对齐 AGENTIC.md §6）：
  - Layer 1：system prompt 中每个 skill 只放名称 + 描述 + 成功率（~30 tokens），写入 `slot:skills`
  - Layer 2：LLM 调用 `read_skill` 工具按需加载完整内容
- **skill 发现**：两层查找 — `brains/<id>/skills/` 优先，`skills/` 全局兜底
- **`read_skill` 工具**：
  ```
  read_skill({ name: "mine_diamond" })
  → { name: "mine_diamond", content: "完整的 skill 内容..." }
  ```
- **skill 元数据**：每个 skill 可选提供 `.meta.json`（描述、标签、成功率），用于 Layer 1 摘要
- **依赖 ContextSlot**：skill 摘要列表写入 `slot:skills`，需要先完成 §4

### 涉及文件

- 新建 `src/loaders/skill-loader.ts` — 发现 + 加载 skill 摘要
- 新建 `tools/read_skill.ts` — 按需读取完整 skill 内容
- `src/context/slot-registry.ts` — skill loader 写入 slot:skills（依赖 §4）

---

## 6. ScriptBrain（纯脚本脑）

当前 Scheduler 遇到无 model 的脑直接跳过。需要实现 ScriptBrain 以支持纯算法脑（如 HTN+GOAP Planner、Executor）。

### 核心设计

`src/` 是脑的**计算内核**，不是 LLM 工具（工具在 `tools/`）。控制流方向相反：

| 目录 | 控制流 | 用途 |
|------|--------|------|
| `tools/` | LLM → 工具 | LLM 决定何时调用 |
| `src/` | 事件 → 脚本 | 框架直接调用，不经过 LLM |

### 生命周期约定

检测 `brains/<id>/src/index.ts` 是否存在，存在则自动加载：

```typescript
// brains/<id>/src/index.ts
import type { Event } from "../../../src/core/types.js";

interface ScriptContext {
  brainId: string;
  emit: (event: Event) => void;
  readState: (targetBrainId: string) => Promise<Record<string, unknown>>;
}

export async function start(ctx: ScriptContext): Promise<void> {
  // 初始化：加载 HTN 方法库、GOAP 动作定义等
}

export async function update(events: Event[], ctx: ScriptContext): Promise<void> {
  // 每批事件到来时调用：跑算法 → emit 结果
}
```

- `start()` — 脑启动时调用一次，可选
- `update()` — 每批事件触发时调用，必须

### Agent Loop

骨架与 ConsciousBrain 完全一致，唯一区别是 process 阶段调脚本而非 LLM：

```typescript
// ScriptBrain.run()
await this.startFn?.(this.ctx);           // 初始化（一次）
while (!signal.aborted) {
  const trigger = await this.eventQueue.waitForEvent(signal);
  if ((trigger.priority ?? 1) > 0) await sleep(this.coalesceMs);
  const events = this.eventQueue.drain();
  if (events.length === 0) continue;
  await this.updateFn(events, this.ctx);  // 调 update.ts，不调 LLM
}
```

### Scheduler 分支

```typescript
const hasSrc = existsSync(join(ROOT, "brains", brainId, "src", "index.ts"));

if (model)           → ConsciousBrain  // 有 LLM，src/ 忽略
if (!model && hasSrc) → ScriptBrain    // 无 LLM，跑脚本
if (!model && !hasSrc) → warn + skip   // 既无 model 也无 src
```

### 关于 HybridBrain（暂缓）

理论上 model + src/ 可以构成混合脑（脚本为主，LLM 为辅），但引入了脑内通信和优先级的额外复杂度。
当前不实现。如果未来需要"算法 + LLM 辅助"场景，可以用两个独立脑（ScriptBrain 计算 + ConsciousBrain 咨询）通过 BrainBus 协作替代，避免单脑内的复杂度。

### 涉及文件

- 新建 `src/core/script-brain.ts` — ScriptBrain 类 (~60 行)
- `src/core/types.ts` — 新增 ScriptContext 接口
- `src/core/scheduler.ts` — 加 hasSrc 检测 + 分支创建 ScriptBrain

---

## 7. 删除 state.json，slot_board + brain_board 分工

### 问题

当前 `state.json` 存在两个问题：
1. **内容无用**：框架往里写运营指标（lastTick、eventsProcessed），模型 read_state 读到一堆时间戳
2. **职责被掏空**：state.json 原本想做的每一件事，都已有更好的归属

```
state.json 想做的:           现在谁做:
─────────────────────        ─────────────────────
运营指标                      → brain_board（公开，manage_brain 查询）
派发任务追踪                  → slot_board（私有 Slot，自动订阅）
短期记忆                      → session history
长期记忆                      → memory/ 目录（§1 记忆刷写）
目标/待办                     → slot:todos
```

**结论：删除 state.json。** 它不再是脑的必须文件。
脑的最小文件集从 `brain.json` + `state.json` + `soul.md` 变为 `brain.json` + `soul.md`。

### 两个概念的区分

| | slot_board（私有 Slot） | brain_board（公开查询） |
|---|---|---|
| **是什么** | 每个脑 system prompt 中的 `slot:slot_board` | `manage_brain({ action: "list" })` 返回的全局数据 |
| **谁看** | 只有自己看（在 system prompt 里） | 任何脑主动查询 |
| **内容** | "我派出去的任务回来了没" | "所有脑的运行状态" |
| **写入方式** | 框架自动：派发任务时订阅，回传时更新 | Scheduler 维护 RuntimeStats |
| **典型内容** | `[▶ planner] 挖钻石 \| 执行中` | `planner: running, tick:142, model:flash` |
| **存在形式** | Slot（§4 的 entries 模式） | 运行时数据，通过工具查询 |

### 需要做的

#### 7.1 删除 state.json 相关代码

- 删除 `brain.ts` 的 `updateState()` 方法
- 删除 `context-engine.ts` 中 Layer 2 (State) 的读取和注入
- 删除 `read_state` 工具（用 `read_file` + `manage_brain` 替代）
- 删除 `ToolContext.readState` 方法

#### 7.2 slot_board — 私有 Slot（自动订阅）

`slot:slot_board` 是每个脑 system prompt 中的一个复合 Slot。
派发任务的工具（send_message、spawn_thought）调用时，框架自动订阅目标脑的回传消息到发起方的 slot_board。

**自动订阅流程**：

```
1. Brain A 调用 send_message({ to: "planner", content: "分解挖钻石目标" })
   → 框架自动在 Brain A 的 slot:slot_board 中注册追踪条目

2. Brain A 的下次 tick，system prompt 中自然看到:

   ## Slot Board
   - [▶ planner] 任务: "分解挖钻石目标" | 执行中

3. Planner 通过 BrainBus 回传结果
   → 框架自动更新 Brain A 的 slot:slot_board 对应条目

4. Brain A 再次 tick 时看到:

   ## Slot Board
   - [✓ planner] 任务: "分解挖钻石目标" | 完成 | 结果: "3个子目标..."
```

**实现方式**：复合 Slot（§4.1 的 entries 模式）：

```
slot "slot_board"   order: 20   source: framework
  ↑ 写入: 派发任务工具自动注册 entry
  ↑ 更新: BrainBus 收到回传时自动更新 entry
  ↑ 清理: 已完成条目通过 ttl 自动过期
```

依赖 §4 ContextSlot 化。§4 之前可用简化版：
框架维护 per-brain 的 tracked tasks 数组，assemblePrompt 时渲染到 system prompt。

#### 7.3 brain_board — 公开查询

全局运营数据不进 slot（避免污染 system prompt），通过工具主动查询：

```
manage_brain({ action: "list" })
→ [
    { id: "listener", model: "gemini-2.5-flash", status: "running", tickCount: 142, subs: ["stdin"] },
    { id: "planner", model: null, status: "running", tickCount: 89, type: "script" },
    ...
  ]
```

数据来源：Scheduler 维护 `Map<brainId, RuntimeStats>`。
用途：IntentBrain 做 ROI 审计、ReflectBrain 分析系统健康度。

### 涉及文件

- `src/core/brain.ts` — 删除 `updateState()`，新增 per-brain tracked tasks
- `src/core/types.ts` — 删除 `ToolContext.readState`，新增 TrackedTask 类型
- `src/context/context-engine.ts` — 删除 Layer 2 (State)，添加 slot_board 渲染
- `tools/read_state.ts` — 删除（功能由 read_file + manage_brain 替代）
- `tools/send_message.ts` — 发送任务时自动注册 slot_board 追踪条目
- `src/core/scheduler.ts` — 新增 RuntimeStats（给 manage_brain list 用）

---

## 8. 通用工具补全

MineCortex Agent 的本质操作是管理本地文件系统（读写 brains/、skills/、src/ 来驱动游戏）。
当前只有 1 个工具（send_message），需要补全基础工具集。
（`read_state` 已随 state.json 一同废弃，见 §7。）

### 认知基础

agentic_os 有 30+ 工具，但 MineCortex 的多脑范式提供了更高的抽象层次：
- agentic_os 的 `spawn_agent` + `agent_status` + `agent_kill` + `switch_persona` + `switch_model`
  → MineCortex 用一个 `manage_brain` 统一
- agentic_os 的 `switch_session` → **不映射** — Session 自动维护（三层压缩 + compact）
- agentic_os 的 `spawn_agent`（匿名模式）→ `spawn_thought`（§2）
- agentic_os 的订阅/触发管理 → `manage_subscription`（§3）

因此 MineCortex 用 ~16 个工具即可覆盖 agentic_os 30+ 工具的等价能力。

### 需要补全的工具

#### 8.1 文件操作（6 个）— 基础设施

| 工具 | 对齐 agentic_os | 用途 |
|------|---------------|------|
| `read_file` | `read_file` | 读取任意文件（soul.md、skill 内容、日志、其他脑的代码） |
| `write_file` | `write_file` | 创建/覆写文件（创建脑目录结构、写 skill、写 proposal） |
| `edit_file` | `edit_file` | 字符串替换编辑（修改 brain.json、微调 soul.md、改 BT 模板） |
| `glob` | `glob` | 文件模式匹配（发现 skills、搜索 brains/、扫描日志） |
| `grep` | `grep` | 内容搜索（搜索日志中的错误、查找 skill 关键词） |
| `bash` | `bash` | Shell 命令执行（运行脚本、查看进程、git 操作） |

##### Brain-aware 路径解析

**设计灵感**：参考 agent_fcos 的 Workspace Zone 模式（`[workspace:]zone/path`），
MineCortex 的文件工具原生支持 **brain 上下文路径**，让 Agent 操作 brain 文件时
不需要拼写完整路径。

**路径解析规则**：

```
read_file({ path: "soul.md", brain: "planner" })
→ 解析为 brains/planner/soul.md

write_file({ path: "skills/mine.md", brain: "responder" })
→ 解析为 brains/responder/skills/mine.md

edit_file({ path: "brain.json", brain: "listener" })
→ 解析为 brains/listener/brain.json

read_file({ path: "soul.md" })
→ brain 省略时，默认为调用者自身的 brain 目录
→ 等效于 read_file({ path: "soul.md", brain: ctx.selfId })

read_file({ path: "src/core/brain.ts" })
→ 无 brain 参数 + 路径不在 brains/ 下 → 按项目根目录解析
```

**核心接口**：

```typescript
interface BrainAwarePath {
  path: string;        // 相对路径
  brain?: string;      // brain id，省略时为调用者自身
}

function resolvePath(input: BrainAwarePath, ctx: ToolContext): string {
  if (input.brain) {
    return join(BRAINS_DIR, input.brain, input.path);
  }
  // 无 brain 参数：如果路径看起来是 brain 内部文件（soul.md、brain.json、
  // skills/、memory/ 等已知 pattern），默认解析到调用者自身的 brain 目录
  if (isBrainLocalPattern(input.path)) {
    return join(BRAINS_DIR, ctx.selfId, input.path);
  }
  // 否则按项目根目录解析
  return join(PROJECT_ROOT, input.path);
}
```

**对比 agent_fcos 的 Zone 设计**：

| agent_fcos | MineCortex |
|-----------|----------|
| `[workspace:]zone/path` | `path` + `brain?` 参数 |
| Zone（assets/data/output/...）按职责分区 | Brain 目录本身就是天然分区（soul.md/brain.json/skills/memory/） |
| workspace 前缀指定其他节点 | `brain` 参数指定其他脑 |
| 默认当前 workspace | 默认调用者自身 brain |
| Clone 时 workspace 上下文复制 | spawn_thought 时 selfId 继承 |

MineCortex 不需要 Zone 层——brain 目录结构本身已经是分区。
`brain` 参数 = agent_fcos 的 workspace 前缀，提供跨脑访问能力。

**权限控制**：

```
默认模式：
  - 自身 brain 目录：读写
  - 其他 brain 目录：只读（可读 soul.md，不可改别人的配置）
  - skills/ / src/：只读

evolve 模式：
  - 自身 brain 目录：读写
  - 其他 brain 目录：读写（可帮别的脑改 soul.md）
  - skills/ / src/：读写（可创建新 skill、修改代码）
```

实现参考：可直接复用 agentic_os 的 `src/tools/` 实现，适配 MineCortex 的 ToolDefinition 接口。
权限控制：结合 AGENTIC.md §7 的权限矩阵（默认模式 vs evolve 模式）。

#### 8.2 脑管理（1 个）— 统一抽象

**`manage_brain` 工具**：统一 agentic_os 的 spawn/kill/persona/model 操作。

> 旧设计中的 `status` action 已移除——它依赖已废弃的 state.json。
> 单脑详情直接通过 `list` 返回（每个 entry 包含完整运行时信息），
> 或通过 `read_file({ path: "brain.json", brain: "planner" })` 读取配置。

```
manage_brain({ action: "list" })
→ 列出所有脑 + 运行时状态（从 Scheduler RuntimeStats 读取）
→ [
    { id: "listener", model: "gemini-2.5-flash", status: "running",
      tickCount: 142, subs: ["stdin"], type: "llm" },
    { id: "planner", model: null, status: "running",
      tickCount: 89, type: "script" },
    ...
  ]

manage_brain({ action: "list", id: "planner" })
→ 按 id 过滤，返回单脑详情（等效于旧 status action，但数据来源是运行时而非 state.json）

manage_brain({ action: "start", id: "reviewer" })
→ 热启动一个脑（Scheduler 动态加载 brains/<id>/）

manage_brain({ action: "stop", id: "reviewer" })
→ 停止脑（保留目录，可恢复）

manage_brain({ action: "restart", id: "reflect" })
→ 重启脑（配置变更后生效）
```

**与文件工具的协作模式**：

```
# 创建新脑（创建目录 = 长出新脑）
write_file({ path: "brain.json", brain: "explorer", content: '{"model":"..."}' })
write_file({ path: "soul.md", brain: "explorer", content: "..." })
manage_brain({ action: "start", id: "explorer" })

# 修改脑配置
edit_file({ path: "brain.json", brain: "social", old: ..., new: ... })
manage_brain({ action: "restart", id: "social" })

# 查看其他脑的 soul
read_file({ path: "soul.md", brain: "planner" })
```

`manage_brain` 只管运行时生命周期（start/stop/restart/list），
脑的配置和内容完全通过 brain-aware 文件工具管理，职责清晰不重叠。

#### 8.3 子任务（1 个）— 已在 §2 规划

`spawn_thought` — 见 §2 + architecture-deep-dive.md §3。

#### 8.4 待定工具

| 工具 | 优先级 | 说明 |
|------|-------|------|
| `todo_write` | §4 后 | 写入 `slot:todos`，需要 Slot 化完成 |
| `compact` | §1 同步 | 手动触发上下文压缩 |
| `web_search` / `web_fetch` | 低 | 查 Minecraft Wiki 等，按需添加 |

### 涉及文件

- 新建 `src/tools/resolve-path.ts` — brain-aware 路径解析核心（`resolvePath` + `isBrainLocalPattern` + 权限校验）
- 新建 `tools/read_file.ts` — 参数含 `brain?`
- 新建 `tools/write_file.ts` — 参数含 `brain?`
- 新建 `tools/edit_file.ts` — 参数含 `brain?`
- 新建 `tools/glob.ts` — 参数含 `brain?`（可选，限定搜索范围到某个 brain 目录）
- 新建 `tools/grep.ts` — 参数含 `brain?`（可选）
- 新建 `tools/bash.ts`
- 新建 `tools/manage_brain.ts` — 只有 list / start / stop / restart（无 status）
- `src/core/scheduler.ts` — 暴露动态启动/停止脑的接口 + RuntimeStats
- `src/core/types.ts` — ToolContext 扩展（scheduler 引用、selfId）
- 删除 `tools/read_state.ts`（§7 一并处理）

---

## 优先级建议

```
§7 删除 state.json     ──→  立即可做，删代码
§8 通用工具补全        ──→  基础设施，解锁 Agent 自主文件管理能力
§0 fs-watcher          ──→  热更新基础，§4 的惰性求值依赖它
§4 ContextSlot 化      ──→  §5 Skills（依赖 slot）
                       ──→  §7 slot_board（依赖 slot）
                       ──→  与 §0 联动（invalidate）
§6 ScriptBrain         ──→  独立，可并行
§1 Session 管理        ──→  独立，可并行
§2 工具发消息          ──→  基础已有，按需补充 spawn_thought
§3 动态订阅            ──→  独立，需 Scheduler 扩展
```

建议执行顺序：

1. **§7 + §8.1**（删除 state.json + 文件操作工具）— 最紧急，清理错误设计 + 解锁基础能力
2. **§0 + §4**（fs-watcher + Slot 化）— 一起做，Slot 的惰性求值 + invalidate 天然需要 fs-watcher
3. **§8.2 + §7 slot_board**（manage_brain + slot_board 作为 Slot）— §4 完成后实现
4. **§1 / §5 / §6**（Session / Skills / ScriptBrain）— 可并行推进
5. **§2 / §3**（spawn_thought / 动态订阅）— 按需补充
