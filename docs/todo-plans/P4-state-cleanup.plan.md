---
name: "P4: 状态清理 — delete state.json + brain_board"
order: 4
overview: "删除 state.json 机制，实现 brain_board 动态注册表（Map<string,unknown>，无固定 schema）和三层 token 统计。"
depends_on: ["P0"]
unlocks: ["P7"]
parallel_group: "phase-1"
todos:
  - id: brain-board
    content: "新建 src/core/brain-board.ts — BrainBoard 类: Map<brainId, Map<string, unknown>> + BrainBoardAPI 实现(含 watch 响应式 hook)"
  - id: token-stats
    content: "新建 src/core/token-stats.ts — estimateTokens(content, spec) 本地估算(ASCII 0.25 + CJK 1.0 + 图片 3000)"
  - id: delete-state-brain
    content: "修改 src/core/brain.ts — 删除 updateState() + 接入 brain_board(process后自动更新 status/currentTurn/lastActivity)"
  - id: delete-state-context
    content: "修改 src/context/context-engine.ts — 删除 Layer 2 (State) 的读取和注入"
  - id: scheduler-board
    content: "修改 src/core/scheduler.ts — 持有 BrainBoard 实例，传给各脑 + 暴露给 manage_brain"
  - id: delete-state-files
    content: "删除 brains/listener/state.json + brains/responder/state.json"
  - id: usage-accumulate
    content: "在 brain.ts process() 中累计 API usage (totalTokensIn/Out) + 更新 brain_board tokens.* 字段"
  - id: model-init-board
    content: "brain.ts init 时注册 model.contextWindow / model.name 到 brain_board（从 ModelSpec 读取）"
---

# P4: 状态清理 — delete state.json + brain_board

## 目标

删除已废弃的 state.json 机制，用 brain_board 动态注册表替代。
同时实现三层 token 统计系统。

## 可并行

与 P1、P2、P3、P5、P6 完全并行。

## brain_board — 动态可扩展状态注册表

`brain_board` 是每个脑对外暴露的公开状态面板。
**不采用硬编码 interface**，而是 `Map<string, unknown>` 动态注册表。

```typescript
type WatchCallback = (value: unknown, prev: unknown) => void;

class BrainBoard implements BrainBoardAPI {
  private boards: Map<string, Map<string, unknown>> = new Map();
  private watchers: Map<string, Map<string, Set<WatchCallback>>> = new Map();

  set(brainId: string, key: string, value: unknown): void {
    if (!this.boards.has(brainId)) this.boards.set(brainId, new Map());
    const board = this.boards.get(brainId)!;
    const prev = board.get(key);
    board.set(key, value);
    this.watchers.get(brainId)?.get(key)?.forEach(cb => cb(value, prev));
  }

  get(brainId: string, key: string): unknown {
    return this.boards.get(brainId)?.get(key);
  }

  remove(brainId: string, key: string): void {
    this.boards.get(brainId)?.delete(key);
  }

  getAll(brainId: string): Record<string, unknown> {
    const board = this.boards.get(brainId);
    if (!board) return {};
    return Object.fromEntries(board);
  }

  watch(brainId: string, key: string, cb: WatchCallback): () => void {
    if (!this.watchers.has(brainId)) this.watchers.set(brainId, new Map());
    const keyMap = this.watchers.get(brainId)!;
    if (!keyMap.has(key)) keyMap.set(key, new Set());
    keyMap.get(key)!.add(cb);
    return () => { keyMap.get(key)?.delete(cb); };
  }
}
```

`watch()` 是框架提供的最本质的响应式 hook：`set()` 时同步触发匹配 key 的 watcher。
返回取消函数，subscription 在 `stop()` 中调用。

### 谁写入什么

| 写入者 | 注册的 key 示例 | 时机 | 说明 |
|--------|---------------|------|------|
| 框架 (brain.ts init) | `model.contextWindow`, `model.name` | 脑初始化时 | 从 ModelSpec 读取，一次性写入 |
| 框架 (brain.ts process) | `status`, `currentTurn`, `lastActivity` | 每轮 turn | process() 中自动注册 |
| 框架 (brain.ts process) | `tokens.lastInputTokens`, `tokens.lastOutputTokens` | 每次 LLM 调用后 | 从 StreamChunk(type:'usage') 提取 |
| 框架 (brain.ts process) | `tokens.sessionInputTotal`, `tokens.sessionOutputTotal` | 每次 LLM 调用后 | 累加 API usage |
| spawn_thought | `thought:t1` | 运行时 | free 后移除 |
| LLM 通过工具 | `currentPlan`, `currentPhase` | 工具调用时 | 脑自己通过工具展示状态 |
| TerminalManager | `activeTerminals` | 终端启停时 | 该脑活跃的后台终端列表 |
| 任意 subscription/tool | 任意 key | 任意 | 键可任意扩展，由注册者自行管理生命周期 |

### 访问方式

- 其他脑通过 `manage_brain({ action: "list" })` 查询完整 brain_board
- Subscription 的 SourceContext 中包含 `brainBoard` 引用（P0 已定义）
- Tool 的 ToolContext 中包含 `brainBoard` 引用（P0 已定义）
- 通过 `brainBoard.watch(brainId, key, cb)` 响应式监听任意 key 变化

## 框架自动写入 brainBoard

### brain.ts init 阶段

```typescript
// 从 ModelSpec 读取，一次性注册到 brainBoard
this.board.set(this.id, 'model.contextWindow', this.modelSpec.contextWindow);
this.board.set(this.id, 'model.name', this.modelName);
```

### brain.ts process() 每次 LLM 调用后

```typescript
const usage = streamResult.usage; // StreamChunk type:'usage'
if (usage) {
  this.board.set(this.id, 'tokens.lastInputTokens', usage.input_tokens);
  this.board.set(this.id, 'tokens.lastOutputTokens', usage.output_tokens);
  const prevIn = (this.board.get(this.id, 'tokens.sessionInputTotal') as number) ?? 0;
  this.board.set(this.id, 'tokens.sessionInputTotal', prevIn + usage.input_tokens);
  const prevOut = (this.board.get(this.id, 'tokens.sessionOutputTotal') as number) ?? 0;
  this.board.set(this.id, 'tokens.sessionOutputTotal', prevOut + usage.output_tokens);
}
```

`tokens.lastInputTokens` 的 `set()` 会同步触发 watch 回调，auto_compact 订阅在此时判断是否超阈值。

## 三层 Token 统计

| 层 | 何时用 | 准确度 | 性能 |
|---|---|---|---|
| 本地估算 | 每轮 turn 前，判断是否触发压缩 | ±20% | 零开销 |
| API Usage | 每轮 turn 后，从 LLM 响应提取 | 100% | 零额外开销 |
| countTokens | 含图片的请求（可选） | 100% | 额外 API 调用 |

```typescript
function estimateTokens(content: string | ContentPart[], spec: ModelSpec): number {
  if (typeof content === "string") {
    return Math.ceil(content.length * (spec.tokensPerChar ?? 0.25));
  }
  let total = 0;
  for (const part of content) {
    if (part.type === "text") total += Math.ceil(part.text.length * (spec.tokensPerChar ?? 0.25));
    if (part.type === "image") total += 3000;
  }
  return total;
}
```

## 涉及文件

| 操作 | 文件 |
|------|------|
| 新建 | `src/core/brain-board.ts` |
| 新建 | `src/core/token-stats.ts` |
| 修改 | `src/core/brain.ts` |
| 修改 | `src/context/context-engine.ts` |
| 修改 | `src/core/scheduler.ts` |
| 删除 | `brains/listener/state.json` |
| 删除 | `brains/responder/state.json` |
