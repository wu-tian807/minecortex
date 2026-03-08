# MineCortex 架构深度探讨 — Slot + Tool 原语与 Thought 机制

> 本文档记录了对 agenticOS/openclaw 的子 Agent 模式的调研分析，
> 以及 MineCortex 如何用自己的架构原生地实现相同能力。
> 结论：不需要新原语，现有 BrainBus + Tool 管道已足够。

---

## 1. 三方调研：子 Agent 模式对比

### 1.1 agenticOS — spawnAgent

agenticOS 的 team-lead 可以 spawn 两种 agent：

| 模式 | 生命周期 | Session | 通信 |
|------|---------|---------|------|
| **匿名 agent** | 一次性，完成即销毁 | 无持久化 | 结果自动回传 MessageBus |
| **有名 agent (teammate)** | 持久，同名自动恢复 | `teammates/agent_{name}/messages.jsonl` | MessageBus 双向通信 |

三种 agent 类型：

| 类型 | 读写 | 工具集 | 定位 |
|------|------|--------|------|
| explore | 只读 | read_file, glob, grep, bash(受限) | 文件搜索专家 |
| plan | 只读 | 同 explore | 架构规划师 |
| task | 可读写 | 全部（除 spawn_agent） | 自主执行者 |

lead 感知子 agent 的方式：

1. **`<running_agents>` 注入 System Prompt** — 每次 LLM 推理时自动注入正在运行的 agent 列表
2. **`task-board.md`** — 可通过 read_file 主动查看完整状态
3. **结果自动回传** — agent 完成后通过 MessageBus 发 `<agent_message>`

崩溃恢复：匿名 agent 不可恢复（内存态）；teammate 可恢复（messages.jsonl 持久化）。

### 1.2 openclaw — subAgent

- 注册中心持久化到磁盘，崩溃可恢复
- 深度追踪（最大嵌套 2 层），每个 parent 最多 5 个活跃 children
- `subagents` 工具提供 list/kill/steer 三个 action
- Announce 系统推送结果，支持直接投递/排队/注入
- 按深度递减工具权限（leaf agent 禁止再 spawn）

### 1.3 MineCortex — brain

- 永久目录，Scheduler 启动时自动发现
- 各自独立 model/soul/tools/wake policy/state
- BrainBus 对等通信
- 去中心化多脑自治（无 lead/follower 关系）

### 关键结论

| 特性 | agenticOS teammate | MineCortex brain |
|------|-------------------|----------------|
| 谁触发 | lead 主动调用 | Scheduler + WakePolicy 自主唤醒 |
| 自治性 | 无，被动响应 | 有，心跳/事件/消息唤醒 |
| 互相通信 | 通过 lead 中转 | BrainBus 直接对等通信 |
| 事件订阅 | 不能 | 可以（stdin, minecraft-chat 等） |

**有名 agent 和 brain 同构，引入会冲突。匿名 agent（一次性子任务）有价值，但实现方式应该 MineCortex 原生化。**

---

## 2. 核心架构发现：Slot + Tool 两个原语

从 LLM（脑的意识）视角看，它和世界的交互只有两个面：

```
LLM 能 看到 什么 → Slot（感知面）
LLM 能 做到 什么 → Tool（行动面）
```

其他一切都是基础设施，最终汇入这两个原语。

### 2.1 Slot — 感知面

Slot 是 system prompt 中的一个命名区域。LLM 每次推理时都能看到所有可见 slot 的内容。

| 现有概念 | 作为 Slot | 谁写 | 可变性 |
|---------|----------|------|--------|
| soul.md | slot:soul | 文件加载器 | 不可变（identity） |
| runtime info | slot:runtime | 框架自动 | 框架可变 |
| state.json | slot:state | 框架 + brain | 框架可变 |
| directives | slot:directive:* | 加载器 | 条件加载 |
| skills 摘要 | slot:skills | 加载器 | 加载器可变 |
| todo-list (未来) | slot:todos | tool 写入 | **tool 可变** |
| active_thoughts (未来) | slot:active_thoughts | tool/框架 | **tool 可变** |
| world snapshot (未来) | slot:world | MineAvatar 事件 | **事件可变** |

注意：stdin 消息和 BrainBus 消息不是 slot。它们是**增量消息**，
进入 conversation 的 message 流（user role），不持久驻留在 system prompt 中。

### 2.2 Tool — 行动面

Tool 是 LLM 可调用的函数。Tool 的完整能力：

| 能力 | 说明 | 例子 |
|------|------|------|
| 返回结果 | 同步执行，结果作为 tool message 回到对话 | read_state |
| 写 Slot（未来） | 更新 system prompt 中的命名区域 | todo_write |
| 发送 BrainBus 消息 | 已有能力（ctx.brainBus） | send_message |
| 启动后台任务（未来） | async 函数，完成后走 BrainBus 回传 | spawn_thought |

### 2.3 基础设施的归位

所有基础设施最终都汇入 Slot 或 Tool：

| 基础设施 | 汇入 Slot | 汇入 Tool |
|---------|----------|----------|
| BrainBus | 收消息 → notice → message | 发消息 = send_message tool |
| Subscriptions | 事件 → notice → message | — |
| Loaders | 加载内容 → 填充 slot | 加载工具定义 → 注册 tool |
| state.json | 读 → 渲染到 slot | 写 = tool 副作用 |
| soul.md | 身份 → 不可变 slot | — |

### 2.4 设计新功能的决策框架

设计任何新功能时只需要问两个问题：

1. **它需要让 LLM 看到什么？** → 设计一个 Slot
2. **它需要让 LLM 做到什么？** → 设计一个 Tool

如果两者都需要（todo、thought），就是一对 Slot + Tool。

---

## 3. Thought 机制 — 用现有管道实现子 Agent

### 3.1 设计思路演进

最初方案经过三轮迭代：

1. **ThoughtRunner + 临时订阅 + ContextEngine 扩展** — 太重，破坏框架
2. **ThoughtRunner + BrainBus + slot 化** — 较轻，但 slot 化暂不需要
3. **纯 Tool + BrainBus** — 最终方案，零框架改动 ✓

关键洞察：BrainBus + WakePolicy 已经是一套**直接激活**机制。
thought 完成后发 BrainBus 消息，和任何脑给这个脑发消息走同一条路径，
Scheduler 会立刻唤醒目标脑。不需要临时订阅。

### 3.2 最终设计

spawn_thought 是一个普通 Tool。内部启动一个 async 函数做后台 LLM 调用，
完成后通过 BrainBus 把结果发回给 parent 脑。

```
Brain tick N:
  1. LLM 推理 → "需要观察地形"
  2. tool call: spawn_thought({task: "侦察北方地形", model: "gemini-2.5-flash"})
  3. tool 内部:
     a. 创建 async 函数，启动后台 LLM 调用（不 await）
     b. 返回 {thoughtId: "thought_xxx", status: "launched"}
  4. LLM 看到结果，无其他事项，tick 结束
  5. 脑睡去

后台:
  6. async LLM 调用完成
  7. brainBus.send({from: "thought_xxx", to: parentBrainId, content: result})

Brain tick N+1:
  8. Scheduler 收到 BrainBus 消息 → pushNotice → WakePolicy → 唤醒
  9. Brain drain notices → 看到 thought 结果（一条 bus 消息）
  10. LLM 推理，使用结果
```

### 3.3 实现细节

#### 代码结构（概念）

```typescript
// tools/spawn_thought.ts
import type { ToolDefinition } from "../src/core/types.js";
import { createProvider } from "../src/llm/index.js";

export default {
  name: "spawn_thought",
  description: "启动一个后台 LLM 子任务（thought），完成后结果通过消息送达。",
  parameters: {
    task:  { type: "string", description: "thought 要完成的任务描述" },
    type:  { type: "string", description: "类型: observe(只读) / reason(分析) / act(可写)",
             enum: ["observe", "reason", "act"], required: false },
    model: { type: "string", description: "使用的模型（默认用便宜快速模型）",
             required: false },
  },
  async execute(args, ctx) {
    const { task, type = "observe", model = "gemini-2.5-flash" } = args;
    const thoughtId = `thought_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    // 后台执行，不 await
    (async () => {
      try {
        const provider = createProvider(model);
        const systemPrompt = buildThoughtPrompt(type, task);
        const result = await provider.chat([
          { role: "system", content: systemPrompt },
          { role: "user", content: task },
        ]);
        ctx.brainBus.send({
          from: thoughtId,
          to: ctx.brainId,
          content: result.content,
          summary: `thought done: ${task.slice(0, 40)}`,
          ts: Date.now(),
        });
      } catch (err) {
        ctx.brainBus.send({
          from: thoughtId,
          to: ctx.brainId,
          content: `thought failed: ${err.message}`,
          summary: `thought error`,
          ts: Date.now(),
        });
      }
    })();

    return { thoughtId, type, status: "launched", task };
  },
} satisfies ToolDefinition;
```

#### 三种 thought 类型

| 类型 | 定位 | system prompt 引导 | 工具集 |
|------|------|-------------------|--------|
| observe | 观察/搜索 | "你是观察者，只报告看到的事实" | 只读（read_state 等） |
| reason | 分析/推演 | "你是分析师，给出深度分析和建议" | 只读 |
| act | 执行子任务 | "你是执行者，完成指定任务" | 可写（但禁止再 spawn） |

v1 阶段 thought 不携带工具（纯 LLM 推理），后续可按需加入工具支持。

#### yield（脑停下来等待）

不需要框架级 yield 机制。spawn_thought 的 tool result 里包含提示：

```json
{
  "thoughtId": "thought_xxx",
  "status": "launched",
  "task": "侦察北方地形",
  "hint": "thought 已启动，结果将通过消息送达。如无其他事项可结束本轮。"
}
```

LLM 看到 hint 后自然不再调用工具，tick 正常结束。
如果需要强制 yield，在 brain.ts 的 tool loop 里加 3 行检查即可（可选）。

#### active_thoughts 状态追踪（可选）

如果想让脑在 system prompt 中看到"有 thought 在跑"，
最 MineCortex 的方式是写 state.json：

```typescript
// spawn 时：往 state.json 写入 activeThoughts
// 完成时：从 state.json 移除
// ContextEngine 读 state.json 时自然渲染
```

不需要 slot 机制，文件系统即状态。

### 3.4 为什么不需要异步并发

agenticOS 的 lead 需要非阻塞并发是因为它是**持续对话 loop**——
lead 总有别的事可做（回答用户、查看代码、编辑文件）。

MineCortex 的脑是 **tick 制**——tick 做完就睡。
脑内部通常是线性决策链：观察→分析→决定→执行。
真正的并发发生在**脑与脑之间**（多个脑各自独立 tick），
不需要在一个脑内部做并发。

并行观察（同时查背包、查地形、查状态）不需要新机制——
LLM 一次可以返回多个 tool call，`Promise.all` 已经并行执行。

### 3.5 直接激活 vs 消息传递

MineCortex 已有的两条路径自然覆盖 thought 的需求：

| 路径 | 机制 | 用于 |
|------|------|------|
| 直接激活 | BrainBus → pushNotice → WakePolicy → wake → runTick | thought 完成后**立刻**唤醒 parent |
| 消息传递 | BrainBus → pushNotice → notice 累积 → 下次 tick drain | 低优先级通知，等心跳处理 |

具体走哪条取决于 parent 脑的 WakePolicy。
比如 responder 的 `wake.ts` 是 `notice.kind === "bus"` 就唤醒，
所以 thought 完成后会**立刻**触发 parent 的下一个 tick。

---

## 4. Slot 化路线图（未来）

当前不做 slot 化。但当以下场景出现时可以启动：

| 触发条件 | 需要的 slot |
|---------|-----------|
| todo_write 工具 | slot:todos（tool 可写） |
| world snapshot 实时推送 | slot:world（事件可写） |
| 多个 thought 并行运行 | slot:active_thoughts（框架可写） |
| skill 动态加载 | slot:skills（加载器可写） |

Slot 化的核心改动：

1. `types.ts` — 新增 `ContextSlot` 类型
2. `context-engine.ts` — 从硬编码层变为 slot 迭代渲染
3. `ToolContext` — 新增 `readSlot(name)` / `writeSlot(name, content)`
4. 各 loader — 改为写 slot 而非直接拼字符串

改动集中在 context 层，不影响 core 层（scheduler/brain/bus）。

---

## 5. 完整架构图

```
                        ┌─────────────┐
                        │     LLM     │  意识层
                        │  (推理引擎)  │
                        └──────┬──────┘
                               │
                 ┌─────────────┼─────────────┐
                 │             │             │
          ┌──────▼──────┐     │     ┌───────▼───────┐
          │    Slot      │     │     │     Tool      │  原语层
          │  (感知面)    │     │     │   (行动面)     │
          │ system prompt│     │     │ 同步/异步      │
          └──────▲──────┘     │     └───────┬───────┘
                 │            │             │
      ┌──────────┼────────────┼─────────────┼──────────┐
      │          │            │             │          │
  ┌───▼───┐ ┌───▼───┐  ┌─────▼─────┐ ┌─────▼─────┐   │
  │ Soul  │ │Loaders│  │ BrainBus  │ │   State   │   │  基础设施层
  │(.md)  │ │(skill/│  │ (消息通道) │ │(.json+fs) │   │
  │       │ │ dir/  │  │           │ │           │   │
  └───────┘ │ tool) │  └─────┬─────┘ └───────────┘   │
            └───────┘        │                        │
                       ┌─────▼─────┐  ┌───────────┐   │
                       │  Notice   │  │Subscript. │   │
                       │  Queue    │  │(stdin...) │   │
                       └─────┬─────┘  └─────┬─────┘   │
                             │              │          │
                       ┌─────▼──────────────▼─────┐   │
                       │     WakePolicy           │   │  自主层
                       │  + Scheduler (调度)       │   │
                       └──────────────────────────┘   │
                                                      │
      ┌───────────────────────────────────────────────┘
      │
      │  外部世界
      ├── MineAvatar (Java, WebSocket)
      ├── 用户 (stdin)
      └── 其他脑 (BrainBus)
```

### 核心公式

```
意识  = LLM
感知  = Slot（有序、有名、有权限的上下文片段）
行动  = Tool（有参数、有权限的可调用函数）
自主  = WakePolicy + Scheduler（何时唤醒意识）
身份  = soul.md（不可变的 identity slot）
```

### 设计准则

- **brain 是"谁"，thought 是"做什么"** — 不混淆
- **有名 agent 不引入** — brain 已是其超集
- **匿名子任务用 Tool + BrainBus** — 不加新原语
- **slot 化延后** — 等真实需求出现再做
- **Tool 是脑的手脚，Slot 是脑的眼睛** — 所有新功能归入这两类

---

## 6. 与 agenticOS / openclaw 的设计差异总结

| 设计决策 | agenticOS | openclaw | MineCortex |
|---------|-----------|----------|----------|
| 子 Agent 机制 | AgentRegistry + TaskBoard + MessageBus | SubagentRegistry + Announce | **纯 Tool + BrainBus（零新基础设施）** |
| 并发模型 | lead 对话 loop 内并发 | gateway 级并发 | **脑间并发（tick 制，脑内线性）** |
| 状态感知 | `<running_agents>` 硬编码注入 | subagents 工具查询 | **state.json / slot（文件系统即状态）** |
| 崩溃恢复 | 匿名不可恢复 | 注册表持久化 | **不恢复（游戏场景重试优于恢复）** |
| prompt 动态化 | factory.ts 硬编码注入点 | extraSystemPrompt 参数 | **slot 化（未来，通用渲染器）** |
| 架构原语 | 无统一原语 | 无统一原语 | **Slot + Tool 两个原语** |
