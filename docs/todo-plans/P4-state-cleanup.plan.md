---
name: "P4: 状态清理 — delete state.json + brain_board"
order: 4
overview: "删除 state.json 机制，实现 brain_board 动态注册表（Map<string,unknown>，无固定 schema）和三层 token 统计。"
depends_on: ["P0"]
unlocks: ["P7"]
parallel_group: "phase-1"
todos:
  - id: brain-board
    content: "新建 src/core/brain-board.ts — BrainBoard 类: Map<brainId, Map<string, unknown>> + BrainBoardAPI 实现"
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
class BrainBoard implements BrainBoardAPI {
  private boards: Map<string, Map<string, unknown>> = new Map();

  set(brainId: string, key: string, value: unknown): void {
    if (!this.boards.has(brainId)) this.boards.set(brainId, new Map());
    this.boards.get(brainId)!.set(key, value);
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
}
```

### 谁写入什么

| 写入者 | 注册的 key 示例 | 说明 |
|--------|---------------|------|
| 框架 (brain.ts) | `status`, `currentTurn`, `lastActivity` | process() 中自动注册 |
| Token 统计 | `tokens.currentSession`, `tokens.contextUtilization` | 每轮 turn 后更新 |
| spawn_thought | `thought:t1` | 运行时注册，free 后移除 |
| LLM 通过工具 | `currentPlan`, `currentPhase` | 脑自己通过工具展示状态 |
| TerminalManager | `activeTerminals` | 该脑活跃的后台终端列表 |

### 访问方式

- 其他脑通过 `manage_brain({ action: "list" })` 查询完整 brain_board
- Subscription 的 SourceContext 中包含 `brainBoard` 引用

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
