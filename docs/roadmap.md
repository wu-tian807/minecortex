# MineClaw 路线图

> 基于当前已完成的 agentic_os 风格 Agent Loop 架构，后续待做事项。

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

## 4. ContextSlot 化 PromptAssemble

当前 `context-engine.ts` 用硬编码拼接 5 层 system prompt，不可扩展，events 重复出现在 system prompt 和 user message 中。

### 核心设计：Directive 就是 Slot

当前 directive 系统（`.ts` 配置 + `.md` 内容，有 order、condition、变量替换）和 slot 概念高度重叠。
**Directive 不再是独立系统，而是 slot 的一种加载方式（file-based, condition-gated）。**

所有 system prompt 内容统一为 slot：

```
slot "soul"                  order: 0     source: file       ← soul.md
slot "runtime"               order: 10    source: framework  ← 自动生成
slot "state"                 order: 20    source: framework  ← state.json
slot "tools"                 order: 30    source: loader     ← tool-loader
slot "directive:identity"    order: 40    source: file       ← identity.ts + .md
slot "directive:tool-usage"  order: 41    source: file       ← condition: hasTools
slot "directive:brain-comm"  order: 42    source: file       ← condition: hasTools
slot "skills"                order: 50    source: loader     ← skill-loader
slot "todos"                 order: 60    source: tool       ← 工具可写
slot "world"                 order: 70    source: framework  ← MineAvatar 推送
```

### 需要做的

- **SlotRegistry**：每个脑持有一个 SlotRegistry，管理命名 slot 的有序集合
  ```typescript
  interface ContextSlot {
    name: string;
    order: number;
    content: string;
    source: "file" | "loader" | "tool" | "framework";
    condition?: (ctx: DirectiveContext) => boolean;  // 渲染时检查
  }
  ```
- **system prompt = slots 渲染**：
  ```typescript
  registry.all()
    .filter(slot => !slot.condition || slot.condition(ctx))
    .sort((a, b) => a.order - b.order)
    .map(slot => slot.content)
    .join("\n\n");
  ```
  context-engine 的 5 层硬编码全部消失，变成 filter → sort → join。
- **Directive loader 变为 slot populator**：不再是独立系统，而是往 SlotRegistry 写入 `directive:*` slot
- **events 仅进 user message**：从 system prompt 中移除 events 层
- **ToolContext 扩展**：`readSlot(name)` / `writeSlot(name, content)` 让工具可以读写 slot

### 涉及文件

- `src/core/types.ts` — 新增 ContextSlot, ToolContext 加 readSlot/writeSlot
- 新建 `src/context/slot-registry.ts` — SlotRegistry 类
- `src/context/context-engine.ts` — 从硬编码改为 slot 迭代渲染
- `src/loaders/directive-loader.ts` — 改为 slot populator，不再独立输出字符串
- `src/core/brain.ts` — 持有 SlotRegistry, process 前刷新 state slot
- `src/core/scheduler.ts` — 初始化时创建 SlotRegistry 并加载初始 slot

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

## 优先级建议

```
§4 ContextSlot 化  ──→  §5 Skills 系统（依赖 slot）
§6 ScriptBrain     ──→  独立，可并行
§1 Session 管理    ──→  独立，可并行
§2 工具发消息      ──→  基础已有，按需补充工具
§3 动态订阅        ──→  独立，需 Scheduler 扩展
```

§4 是基础设施，§1/§5 依赖或受益于它，建议优先。§6 和 §2/§3 相对独立，可以穿插进行。
