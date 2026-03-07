---
name: "P0: 共享契约层"
order: 0
overview: "在 types.ts 中定义所有 Plan 共享的接口契约，使后续 P1-P10 可以独立开发。这是所有 Plan 的前置依赖。"
depends_on: []
unlocks: ["P1", "P2", "P3", "P4", "P5", "P6"]
parallel_group: "phase-0"
todos:
  - id: content-part
    content: "定义 ContentPart / SerializedPart 多模态内容原语"
  - id: llm-message
    content: "重写 LLMMessage 支持 string | ContentPart[] + thinking + truncated + ts"
  - id: llm-response
    content: "重写 LLMResponse 添加 thinking / rawAssistantMessage / ContentPart[] content"
  - id: stream-chunk
    content: "定义 StreamChunk 联合类型 (text/thinking/tool_call/usage)"
  - id: tool-definition
    content: "重写 ToolDefinition: parameters → input_schema(JSON Schema) + ToolOutput 返回类型"
  - id: tool-context
    content: "扩展 ToolContext: 新增 signal / brainBoard / slot / brainBus / workspace / terminalManager / pathManager"
  - id: source-context
    content: "扩展 SourceContext: 新增 brainBoard 引用（对齐 P4/P7 要求，contextWindow 等通过 brainBoard.get() 获取）"
  - id: dynamic-slot-api
    content: "定义 DynamicSlotAPI 接口 (register/update/release/get)"
  - id: brain-board-api
    content: "定义 BrainBoardAPI 接口 (set/get/remove/getAll/watch — watch 为响应式 hook)"
  - id: event-steer
    content: "Event 新增 steer?: boolean 字段"
  - id: context-slot
    content: "定义 ContextSlot / SlotKind / SlotFactory / SlotContext 接口"
  - id: brain-json
    content: "扩展 BrainJson: model 支持 string[] fallback / 新增 env / session / slots"
  - id: llm-provider
    content: "重写 LLMProviderInterface → LLMProvider: chatStream() 必选 + chatResponseStream?() 可选(Response API)"
  - id: model-spec-clarify
    content: "明确 ModelSpec 沿用现有 key/models.json 字段(input/reasoning/contextWindow/maxOutput/defaultTemperature/tokensPerChar)，不引入 openclaw 的 ModelCompatConfig/ModelApi"
  - id: thought-types
    content: "定义 ThoughtType / ThoughtConfig 类型"
  - id: path-manager-api
    content: "定义 PathManagerAPI 接口 (dir/root/brainDir/resolve/checkPermission — 通用路径管理器)"
  - id: fswatcher-api
    content: "定义 FSWatcher 注册接口 (register/unregister/WatchRegistration — 纯注册式，零硬编码)"
  - id: terminal-types
    content: "定义 TerminalInstance / TerminalManagerAPI 接口 (通过 PathManager 定位 workspace/terminals/)"
  - id: cleanup-old
    content: "删除旧类型: ToolParameter / DirectiveConfig / DirectiveContext / LoadedDirective / readState"
---

# P0: 共享契约层 — types.ts 接口重构

## 目标

重写 `src/core/types.ts`，定义所有 Plan 共享的 40+ 个接口/类型。
这是 **所有其他 Plan 的前置依赖**，必须最先完成。

## 核心原则

- 所有 Plan 通过此文件中的接口通信，不可单方面修改
- 保持向后兼容性最小化：旧类型直接删除（ToolParameter、DirectiveConfig 等）
- 每个接口只定义"形状"，不含实现逻辑

## 涉及文件

- **重写** `src/core/types.ts` — 所有契约集中于此

## 关键契约

### 多模态内容原语

```typescript
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type SerializedPart =
  | ContentPart
  | { type: "image_ref"; path: string; mimeType: string };
```

### 工具定义（JSON Schema 直连）

```typescript
export type ToolOutput = string | ContentPart[];

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutput>;
}
```

### LLM Provider（流式优先 + 可选 Response API）

```typescript
export interface LLMProvider {
  chatStream(
    messages: LLMMessage[],
    tools: ToolDefinition[],
    signal: AbortSignal,
  ): AsyncIterable<StreamChunk>;

  supportsResponseAPI?: boolean;
  chatResponseStream?(params: {
    previousResponseId?: string;
    input: LLMMessage[];
    tools: ToolDefinition[];
    signal: AbortSignal;
    store?: boolean;
  }): AsyncIterable<StreamChunk & { responseId?: string }>;
}
```

`chatResponseStream` 是可选方法，仅 `"openai-responses"` 等支持 Response API 的 adapter 实现。
agent loop 优先尝试 Response API（如果 provider 支持且 session 有 lastResponseId），
失败时自动降级为全量 `chatStream()`。

### ModelSpec（沿用现有定义）

`ModelSpec` 已存在于 `key/models.json`，类型保持现有字段不变。
**不引入** openclaw 的 `ModelCompatConfig`、`ModelApi`、`ModelProviderConfig` 等类型。
Provider 差异通过 `llm_key.json` 的 `api` 字段 + 独立 adapter `.ts` 文件解决。

```typescript
export interface ModelSpec {
  input: InputModality[];
  reasoning: boolean;
  contextWindow: number;
  maxOutput: number;
  defaultTemperature: number;
  tokensPerChar: number;
}
```

### PathManager（通用路径管理器）

```typescript
export interface PathManagerAPI {
  root(): string;
  dir(name: string): string;           // "brains" | "tools" | "workspace" | "terminals" | ...
  brainDir(brainId: string): string;
  resolve(input: { path: string; brain?: string }, callerBrainId: string): string;
  checkPermission(absPath: string, op: "read" | "write", callerBrainId: string, evolve: boolean): boolean;
}
```

### FSWatcher（纯注册式文件监听）

```typescript
export interface WatchRegistration {
  id: string;
  dispose(): void;
}

export interface FSChangeEvent {
  type: "create" | "modify" | "delete";
  path: string;
  isDir: boolean;
}

export type FSHandler = (event: FSChangeEvent) => void | Promise<void>;

export interface FSWatcherAPI {
  register(pattern: RegExp, handler: FSHandler, opts?: { debounceMs?: number }): WatchRegistration;
  close(): void;
}
```

### Terminal 管理（bash 工具运行时）

终端日志目录位于 `<PROJECT_ROOT>/workspace/terminals/`（通过 `PathManager.dir("terminals")` 定位）。

```typescript
export interface TerminalInstance {
  id: string;
  pid: number;
  command: string;
  cwd: string;
  brainId: string;
  startedAt: number;
  exitCode?: number;
  elapsedMs?: number;
  logFile: string;        // 绝对路径，由 PathManager 解析
}

export interface TerminalManagerAPI {
  exec(command: string, opts: ExecOpts): Promise<ExecResult>;
  get(id: string): TerminalInstance | undefined;
  list(filter?: { brainId?: string; status?: string }): TerminalInstance[];
  kill(id: string): boolean;
  readOutput(id: string, opts?: { tail?: number }): string;
  cleanup(maxAge?: number): void;
}

export interface ExecResult {
  terminalId: string;
  stdout: string;
  exitCode?: number;
  backgrounded: boolean;
  hint?: string;
}
```

### BrainBoardAPI（动态可扩展状态注册表 + 响应式 watch hook）

```typescript
export type WatchCallback = (value: unknown, prev: unknown) => void;

export interface BrainBoardAPI {
  set(brainId: string, key: string, value: unknown): void;
  get(brainId: string, key: string): unknown;
  remove(brainId: string, key: string): void;
  getAll(brainId: string): Record<string, unknown>;
  watch(brainId: string, key: string, cb: WatchCallback): () => void;
}
```

`watch()` 是框架提供的最本质的响应式 hook。当 `set()` 被调用时同步触发匹配的 watcher。
返回取消函数。用于 auto_compact 订阅监听 `tokens.lastInputTokens` 变化等场景。

### SourceContext（事件源上下文）

```typescript
export interface SourceContext {
  brainId: string;
  brainDir: string;
  config?: Record<string, unknown>;
  brainBoard: BrainBoardAPI;
}
```

`brainBoard` 在固定位置（scheduler 持有，传给 brain → 传给 subscription），
subscription 通过 `brainBoard.get()` 获取 `model.contextWindow`、`tokens.*` 等运行时数据，
无需单独注入 `modelSpec` 或 `sessionManager`。

### 完整类型列表（待定义）

- ContentPart, SerializedPart
- LLMMessage, LLMToolCall, LLMResponse
- StreamChunk
- ToolOutput, ToolDefinition, ToolContext
- DynamicSlotAPI, BrainBoardAPI (含 watch), WatchCallback
- Event (扩展 steer)
- ContextSlot, SlotKind, SlotFactory, SlotContext
- EventSource, EventSourceFactory, SourceContext (含 brainBoard)
- CapabilitySelector, BrainJson, MinecortexConfig, ModelSpec
- ThoughtType, ThoughtConfig
- PathManagerAPI, FSWatcherAPI, WatchRegistration
- TerminalInstance, TerminalManagerAPI, ExecResult
- BrainInterface, ScriptContext

## 约定规范

| 约定 | 规则 |
|------|------|
| 文件编码 | UTF-8, LF 换行 |
| 目录约定 | 全局资源在根目录，脑专属在 `brains/<id>/` 下同名目录 |
| 同名覆盖 | `brains/<id>/xxx/` > `xxx/`（内覆盖外） |
| Factory 导出 | `.ts` factory 导出 `default` 或命名导出 `create` |
| 工具返回值 | 简单 → `string`，多模态 → `ContentPart[]` |
| 事件命名 | source 格式: `"stdin"` / `"bus"` / `"tool:xxx"` / `"system"` |
