---
name: "P10: Agent 子任务 + 生命周期管理"
order: 10
overview: "spawn_thought 工具(observe/plan/act三类型, foreground/background双模式) + Agent loop 统一化 + Steer 事件打断机制(流式中断+partial保留) + 脑生命周期三态(stop/shutdown/free) + 优雅关闭(SIGTERM/SIGINT)。"
depends_on: ["P1", "P7"]
unlocks: []
parallel_group: "phase-3"
todos:
  - id: agent-loop-extract
    content: "重构 src/core/brain.ts — 抽取核心 agent loop 为可复用函数, ConsciousBrain 和匿名 agent 共用"
  - id: spawn-thought
    content: "新建 tools/spawn_thought.ts — 双模式(fg/bg) + ThoughtConfig(observe/plan/act) + CapabilitySelector工具过滤 + 递归限制(act/plan仅可spawn observe)"
  - id: thought-config
    content: "定义 THOUGHT_DEFAULTS 常量: observe(只读,fast,maxIter10) / plan(只读,inherit,maxIter5) / act(读写,inherit,maxIter20)"
  - id: steer-event
    content: "修改 src/core/event-queue.ts — 新增 hasSteerEvent() + onSteer(callback) + steer事件优先级处理"
  - id: steer-interrupt
    content: "修改 brain.ts — turnAbort管理 + steer监听 → abort当前流式调用 + partial content保留(truncated:true)"
  - id: lifecycle-stop
    content: "实现 stop(): abort当前LLM调用, 保留session/subscriptions/slots/brain_board"
  - id: lifecycle-shutdown
    content: "实现 shutdown(): stop + subscriptions stop + slots release + session flush + brain_board清理"
  - id: lifecycle-free
    content: "实现 free(): shutdown + 删除brain_board条目 + 发送完成通知(匿名agent专用)"
  - id: graceful-shutdown
    content: "修改 src/core/scheduler.ts — SIGTERM/SIGINT handler + 全局有序shutdown(并行10s超时)"
  - id: ctrl-c
    content: "实现两阶段 Ctrl+C: 第一次→当前活跃脑stop(), 第二次(3s内)→全局shutdown+exit"
---

# P10: Agent 子任务 + 生命周期管理

## 目标

实现完整的子任务系统（spawn_thought）和脑生命周期管理（Steer + stop/shutdown/free）。

## 依赖

- P1（流式优先设计 + AbortSignal 中断能力）
- P7（动态 Slot API — `ctx.slot.register("thought:t1", ...)` + `release`）

## spawn_thought 设计

### 三种类型（Minecraft 游戏 agent 语义）

| 类型 | 定位 | 工具集 | model | maxIter |
|------|------|--------|-------|---------|
| observe | 只读感知/探索 | read_file, glob, grep, bash | fast | 10 |
| plan | 只读规划/推理 | 同 observe | inherit | 5 |
| act | 全功能执行 | 全部(除 manage_brain) | inherit | 20 |

### 双模式执行

```typescript
spawn_thought({
  task: "调研 X 框架的实现",
  type: "observe",
  model: "gemini-2.5-flash",
  mode: "background",        // background(默认) | foreground(同步等待)
  context: "summary",        // none | summary(默认) | full
  todoId: "research",        // 可选关联动态 Slot
})
```

- **background**：立即返回 `{ thoughtId, status: "launched" }`，后台执行
- **foreground**：同步 await 结果直接返回

### 递归限制

- act/plan 内部 spawn_thought 仅可 spawn observe 类型
- observe 内部完全禁用 spawn_thought

### Background 执行流程

```
① LLM → spawn_thought(task, type, mode: "background")
② tool 内部:
   a. ctx.slot.register("thought:t1", "▶ observe: ${task}")
   b. async(不await):
      - 从父脑过滤工具集(CapabilitySelector)
      - 执行单轮 agent loop(最多 maxIter 轮)
      - 完成: ctx.slot.release + ctx.emit(thought_result)
      - 失败: ctx.slot.release + ctx.emit(thought_error)
   c. 返回 { thoughtId, status: "launched" }
③ LLM 看到 hint, turn 结束
④ 后台完成 → emit → EventQueue → 唤醒脑 → 下一轮 drain 到结果
```

## Steer 机制

### 事件打断流程

```
脑正在流式接收 LLM 响应
  ← steer 事件到达 EventQueue
  ① AbortController.abort() — 中断当前流式调用
  ② 保留已接收的 partial content (truncated: true)
  ③ steer 事件作为新 user message 入队
  ④ 立即开始新一轮 drain → process（不等 coalesce）
```

### Agent loop 与 steer 集成

```typescript
async run(signal: AbortSignal) {
  while (!signal.aborted) {
    const trigger = await this.eventQueue.waitForEvent(signal);

    const hasSteer = this.eventQueue.hasSteerEvent();
    if (!hasSteer && (trigger.priority ?? 1) > 0) {
      await sleep(this.coalesceMs);  // 非 steer 才等 coalesce
    }

    const events = this.eventQueue.drain();
    const turnAbort = new AbortController();
    const steerWatcher = this.eventQueue.onSteer(() => turnAbort.abort());

    try {
      await this.process(events, turnAbort.signal);
    } finally {
      steerWatcher.dispose();
    }
  }
}
```

## 三级生命周期

| 操作 | 触发场景 | 保留 | 释放 |
|------|---------|------|------|
| **stop** | steer/Ctrl+C第一次/manage_brain stop | session+subs+slots+board | 当前LLM调用 |
| **shutdown** | 框架退出/SIGTERM/manage_brain shutdown | 磁盘文件 | session内存+subs+slots+board |
| **free** | spawn_thought 匿名 agent 退出 | 无 | 同shutdown+删board条目+通知 |

## 优雅关闭

```
SIGTERM / SIGINT（第一次）
  ① 所有脑 shutdown()（并行，超时 10s）
  ② FSWatcher close()
  ③ Logger flush + close
  ④ process.exit(0)

Ctrl+C 在 stdin 模式下：
  第一次 → 当前活跃脑 stop()（保留环境）
  第二次（3s 内）→ 全局 shutdown + exit
```

## 涉及文件

| 操作 | 文件 |
|------|------|
| 重构 | `src/core/brain.ts` |
| 新建 | `tools/spawn_thought.ts` |
| 修改 | `src/core/event-queue.ts` |
| 修改 | `src/core/scheduler.ts` |

## 参考实现

- `references/agentic_os/src/tools/spawn-agent.ts` — fire-and-forget + messageBus
- `references/claude-code-system-prompts/.../tool-description-task.md` — fg+bg双模式
- `references/gemini-cli/.../subagent-tool-wrapper.ts` — 防递归
- `references/agentic_os/src/channels/cli.ts` — 两阶段 Ctrl+C
