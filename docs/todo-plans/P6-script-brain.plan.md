---
name: "P6: ScriptBrain"
order: 6
overview: "实现纯脚本脑（非 LLM 驱动）+ Scheduler 分支检测。ScriptBrain 运行算法逻辑（如 HTN+GOAP Planner），完全独立于 LLM。"
depends_on: ["P0"]
unlocks: []
parallel_group: "phase-1"
todos:
  - id: script-brain
    content: "新建 src/core/script-brain.ts — ScriptBrain 类(~60行): load src/index.ts → start() + update(events)"
  - id: script-context
    content: "在 types.ts 中定义 ScriptContext 接口: brainId + emit + brainBoard"
  - id: scheduler-branch
    content: "修改 src/core/scheduler.ts — hasSrc 检测 + 分支创建 ScriptBrain (model→Conscious, !model+hasSrc→Script, else→skip)"
---

# P6: ScriptBrain

## 目标

实现纯脚本脑，支持非 LLM 驱动的算法脑（如 HTN+GOAP Planner、Executor）。

## 可并行

完全独立，可与任何 Plan 并行。体量最小（~60 行核心代码）。

## 核心设计

### 生命周期

```typescript
// brains/<id>/src/index.ts
export async function start(ctx: ScriptContext): Promise<void> {
  // 初始化一次
}

export async function update(events: Event[], ctx: ScriptContext): Promise<void> {
  // 每批事件调用
}
```

### ScriptBrain 类

```typescript
class ScriptBrain implements BrainInterface {
  private startFn?: (ctx: ScriptContext) => Promise<void>;
  private updateFn!: (events: Event[], ctx: ScriptContext) => Promise<void>;
  private ctx: ScriptContext;
  private eventQueue: EventQueue;

  async run(signal: AbortSignal): Promise<void> {
    await this.startFn?.(this.ctx);
    while (!signal.aborted) {
      const trigger = await this.eventQueue.waitForEvent(signal);
      if ((trigger.priority ?? 1) > 0) await sleep(this.coalesceMs);
      const events = this.eventQueue.drain();
      if (events.length === 0) continue;
      await this.updateFn(events, this.ctx);
    }
  }
}
```

### Scheduler 分支检测

```typescript
const hasSrc = existsSync(join(ROOT, "brains", brainId, "src", "index.ts"));

if (model)           → ConsciousBrain
if (!model && hasSrc) → ScriptBrain
if (!model && !hasSrc) → warn + skip
```

## 涉及文件

| 操作 | 文件 |
|------|------|
| 新建 | `src/core/script-brain.ts` |
| 修改 | `src/core/scheduler.ts` |
