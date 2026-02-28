---
name: "P5: 日志系统"
order: 5
overview: "三层记录 — qa.md(人可读问答) + debug.log(工程日志) + Session messages.jsonl(P9负责)。日志异步写入，不阻塞 brain turn。"
depends_on: ["P0"]
unlocks: []
parallel_group: "phase-1"
todos:
  - id: logger
    content: "新建 src/core/logger.ts — 全局 Logger 类: 异步消息队列+单writer + 日志轮转(5次/50MB) + 级别过滤(DEBUG/INFO/WARN/ERROR)"
  - id: qa-recorder
    content: "新建 src/session/qa-recorder.ts — QARecorder 类: 追加写入 qa.md(纯问答Markdown, 不含thinking/tool_calls)"
  - id: brain-logging
    content: "修改 src/core/brain.ts — process() 中接入 logger(LLM输入摘要/输出/工具调用) + qa-recorder(最终回答)"
  - id: terminal-logging
    content: "Logger 与 TerminalManager(P2) 集成: bash 工具的终端日志写入 workspace/terminals/(PathManager定位) + 关键事件同步到 debug.log"
  - id: stdout-split
    content: "实现 stdout 分流: INFO+ 实时输出终端, DEBUG 只写文件"
---

# P5: 日志系统

## 目标

实现三层记录系统。P5 负责 debug.log 和 qa.md，
messages.jsonl 由 P9（Session 管理）负责。

## 可并行

完全独立，可与任何 Plan 并行。

## 三层记录分工

| 层 | 文件 | 格式 | 内容 | 负责 |
|---|---|---|---|---|
| Session | `brains/<id>/sessions/<sid>/messages.jsonl` | JSONL | 完整消息+thinking+tool | **P9** |
| QA | `brains/<id>/sessions/<sid>/qa.md` | Markdown | 纯问答 | **P5** |
| Debug | `debug.log`（全局） | 结构化文本 | LLM I/O + 工具 + 事件 + 错误 | **P5** |

## Logger 类

```typescript
class Logger {
  private queue: LogEntry[] = [];
  private writer: fs.WriteStream;
  private level: LogLevel;

  constructor(opts: { file: string; level: LogLevel; maxSizeMB?: number; maxRuns?: number });

  debug(brainId: string, turn: number, msg: string): void;
  info(brainId: string, turn: number, msg: string): void;
  warn(brainId: string, turn: number, msg: string): void;
  error(brainId: string, turn: number, msg: string, err?: Error): void;

  async flush(): Promise<void>;
  close(): void;
}
```

### 日志格式

```
[10:30:05.123] [INFO]  [responder#7] process 2 events (stdin:message, heartbeat:tick)
[10:30:05.456] [DEBUG] [responder#7] LLM input: 4 messages, system prompt 1200 tokens
[10:30:07.891] [INFO]  [responder#7] LLM output: 156 tokens (thinking: 89)
[10:30:07.892] [INFO]  [responder#7] tool:getInventory({}) → {items:[...]} (32ms)
[10:30:08.001] [WARN]  [responder#7] subscription 'heartbeat' emit failed: TypeError...
[10:30:08.002] [ERROR] [planner#1] LLM call failed: 429 Too Many Requests
```

`brainId#N` 中的 N 是 turn 编号。

### 级别与输出

| 级别 | 内容 | stdout | 文件 |
|------|------|--------|------|
| DEBUG | LLM 输入摘要、完整 tool arguments | 不输出 | 写入 |
| INFO | 事件处理、LLM 输出摘要、工具调用 | 输出 | 写入 |
| WARN | 订阅错误、超时、降级 | 输出 | 写入 |
| ERROR | LLM 调用失败、工具崩溃 | 输出 | 写入 |

## QA Recorder

```markdown
## User
你好，帮我看一下背包里有什么

## Assistant
你的背包里有 3 个钻石、1 把铁剑和 64 个泥土。
```

**规则**：
- 流式追加（fsync 保证持久性）
- 不含 thinking/reasoning、tool_calls、tool_results、系统提示
- 工具过滤参考 agentic_os 的 HIDDEN_TOOLS / QUIET_RESULT_TOOLS

## Terminal 日志集成

bash 工具执行的终端日志保存在 `workspace/terminals/` 中（P2 TerminalManager 管理，通过 PathManager 定位），
同时关键事件（命令启动/完成/失败）也写入 debug.log：

```
[10:31:00.000] [INFO]  [responder#8] terminal:t_xxx started: python train.py (cwd: /workspace)
[10:31:45.230] [INFO]  [responder#8] terminal:t_xxx completed: exit_code=0, elapsed=45230ms
[10:32:00.100] [WARN]  [planner#3] terminal:t_yyy timeout: npm install (30s), backgrounded
```

## 涉及文件

| 操作 | 文件 |
|------|------|
| 新建 | `src/core/logger.ts` |
| 新建 | `src/session/qa-recorder.ts` |
| 修改 | `src/core/brain.ts` |

## 参考实现

- `references/agent_fcos/pkg/runtime/logger.go` — 异步 channel + 轮转
- `references/agentic_os/src/session/memory.ts` — appendUserInfo (QA 层)
