---
name: "P1: LLM 层重构"
order: 1
overview: "流式优先设计 + 重试容错 + Thinking 模型适配 + 多模态贯穿 + 可选 Response API。保留 llm_key.json + models.json 双文件架构和 model@section 语法，Provider 差异通过 api type 注册独立 adapter 文件解决。"
depends_on: ["P0"]
unlocks: ["P9", "P10"]
parallel_group: "phase-1"
todos:
  - id: retry
    content: "新建 src/llm/retry.ts — withRetry() + 指数退避(1s→2s→4s→8s) + retryableStatuses(429/500/502/503)"
  - id: stream-utils
    content: "新建 src/llm/stream.ts — assembleResponse() 从 AsyncIterable<StreamChunk> 组装 LLMResponse + thinking buffer"
  - id: think-tags
    content: "在 stream.ts 中实现 <think> 标签状态机解析 (NORMAL → IN_THINK → NORMAL)"
  - id: modality
    content: "新建 src/core/modality.ts — normalizeContent() + modalityFilter() 按 ModelSpec.input 自动降级"
  - id: gemini-stream
    content: "重写 src/llm/gemini.ts — chatStream() + thought:true part 提取 + 多模态 ContentPart 输入输出"
  - id: anthropic-stream
    content: "重写 src/llm/anthropic.ts — chatStream() + type:thinking block 提取"
  - id: openai-stream
    content: "重写 src/llm/openai-compat.ts — chatStream() + <think> 标签降级解析"
  - id: deepseek-reasoning
    content: "新建 src/llm/deepseek-reasoning.ts — 注册 api type 'deepseek-reasoning', 复用 openai-compat 逻辑 + reasoning_content 提取 + tool loop 内必须回传 + 跨turn清除"
  - id: openai-responses
    content: "(可选) 新建 src/llm/openai-responses.ts — 注册 api type 'openai-responses', 实现 chatResponseStream() + Responses API 格式转换, lastResponseId 存 session 元数据(P9)"
  - id: provider-registry
    content: "修改 src/llm/provider.ts — ProviderFactory 返回类型改为 LLMProvider, 保留现有 registry pattern + model@section 语法"
  - id: fallback-chain
    content: "实现 fallback 模型链: brain.json model 支持 string[], 依次尝试, 切换时 emit model_fallback 事件"
---

# P1: LLM 层重构

## 目标

将所有 LLM Provider 统一为 **流式优先** 设计，非流式是流式的特例。
同时实现重试容错、Thinking 模型适配、多模态内容贯穿、可选 Response API 支持。

## 架构保留

**以下现有设计完全保留不动：**

- `key/llm_key.json` — Provider 连接层（api_key / api_base / api 协议 / models 列表）
- `key/models.json` — Model 能力层（contextWindow / reasoning / input / maxOutput / ...）
- `src/llm/provider.ts` — 现有 registry pattern + `model@section` 语法 + `loadKeyFile()` / `loadModelCatalog()`
- Provider.ts 唯一改动：`ProviderFactory` 返回类型从 `LLMProviderInterface` 改为 `LLMProvider`

**api type 重载机制**：同一 provider 的不同模型如果需要不同 adapter，通过 `llm_key.json` 中分设不同 section 解决：

```json
{
  "deepseek": {
    "api_key": "...", "api_base": "https://api.deepseek.com",
    "api": "openai-completions",
    "models": ["deepseek-chat", "deepseek-v3"]
  },
  "deepseek-reasoning": {
    "api_key": "...", "api_base": "https://api.deepseek.com",
    "api": "deepseek-reasoning",
    "models": ["deepseek-r1", "deepseek-r1-0528"]
  }
}
```

用户使用：`deepseek-r1@deepseek-reasoning` 或直接 `deepseek-r1`（自动匹配 section）。

## 可并行

与 P2、P3、P4、P5、P6 完全并行，无依赖。

## 核心设计

### 流式优先

```
Provider.chatStream(messages, tools, signal) → AsyncIterable<StreamChunk>

// 非流式 = 收集所有 chunks
async function chat(provider, messages, tools, signal): Promise<LLMResponse> {
  return assembleResponse(provider.chatStream(messages, tools, signal));
}
```

### 适配器清单（按 Agentic OS 范围）

| Adapter 文件 | 注册 api type | 覆盖 Provider | Thinking 来源 |
|---|---|---|---|
| `gemini.ts` | `google-generative-ai` | Gemini 全系列 | `thought: true` part (SDK) |
| `anthropic.ts` | `anthropic-messages` | Anthropic, Azure Claude | `type: "thinking"` block (SDK) |
| `openai-compat.ts` | `openai-completions` | OpenAI, DeepSeek-chat, Qwen, Kimi, MiniMax, Ollama | `<think>` 标签（降级解析） |
| `deepseek-reasoning.ts` | `deepseek-reasoning` | DeepSeek-R1 系列 | `reasoning_content` 字段 |
| `openai-responses.ts`（可选） | `openai-responses` | OpenAI/Azure Responses API | `reasoning.effort` 参数 |

### DeepSeek Reasoning 特殊处理

- `deepseek-reasoning.ts` 复用 `openai-compat.ts` 的大部分逻辑，只重载 response 解析
- `reasoning_content` 在 tool loop 内**必须传回 API**（否则 400 错误）
- 跨 turn 时清除 `reasoning_content`（避免无效上下文累积）

### Response API（可选）

- `openai-responses.ts` 实现 `LLMProvider.chatResponseStream?()` 方法
- Responses API 格式转换：messages → input/instructions 格式
- `lastResponseId` 存储在 session 元数据中（P9 联动）
- `previousResponseId` 失效时自动降级为全量 `chatStream()`

### 重试策略

```
retryableStatuses: [429, 500, 502, 503]
不重试: 400(参数错误), 401(认证失败), 403(权限不足)
退避: 1s → 2s → 4s → 8s (2^n * baseDelay)
maxRetries: 3 (默认)
```

### Fallback 模型链

```json
// brain.json
{ "model": ["gemini-2.5-pro", "gemini-2.5-flash"] }
```

- 第一个模型超过 maxRetries → 切换下一个
- emit `{ type: "model_fallback", payload: { from, to } }`
- 全部失败 → emit `{ type: "llm_error" }`

### 多模态降级

```typescript
function modalityFilter(parts: ContentPart[], spec: ModelSpec): ContentPart[] {
  return parts.map(p => {
    if (p.type === "image" && !spec.input.includes("image"))
      return { type: "text", text: "[Image: 模型不支持图片输入]" };
    return p;
  });
}
```

## 涉及文件

| 操作 | 文件 | 说明 |
|------|------|------|
| 新建 | `src/llm/retry.ts` | withRetry + 指数退避 |
| 新建 | `src/llm/stream.ts` | assembleResponse + thinking buffer + `<think>` 状态机 |
| 新建 | `src/llm/deepseek-reasoning.ts` | 注册 `"deepseek-reasoning"` api type, reasoning_content 提取 |
| 新建 | `src/llm/openai-responses.ts` | (可选) 注册 `"openai-responses"` api type, Response API |
| 新建 | `src/core/modality.ts` | normalizeContent + modalityFilter |
| 重写 | `src/llm/gemini.ts` | chatStream |
| 重写 | `src/llm/anthropic.ts` | chatStream |
| 重写 | `src/llm/openai-compat.ts` | chatStream |
| 修改 | `src/llm/provider.ts` | ProviderFactory 返回类型改为 LLMProvider |
| 修改 | `src/llm/index.ts` | 新增 import deepseek-reasoning.js (+可选 openai-responses.js) |
| 不动 | `key/llm_key.json` | 现有 Provider 连接配置保持不变 |
| 不动 | `key/models.json` | 现有 Model 能力定义保持不变 |

## 对外接口

- `LLMProvider.chatStream()` → `AsyncIterable<StreamChunk>` — P10 用 AbortSignal 中断
- `LLMProvider.chatResponseStream?()` → Response API 增量调用（P9 联动 lastResponseId）
- `assembleResponse()` → `LLMResponse` — P9 用 usage 字段累计 token
- `modalityFilter()` — 在 provider 调用前自动降级

## 参考实现

- 重试 + 适配器: `references/agentic_os/src/llm/` — gemini.ts / anthropic-compat.ts / openai-compat.ts
- Response API: `references/agentic_os/src/llm/azure-openai-responses.ts` — Responses API 完整实现
- Thinking: `references/openclaw/src/agents/pi-embedded-utils.ts`
- `<think>` 标签: `references/openclaw/src/shared/text/reasoning-tags.ts`
- 多模态: `references/gemini-cli/packages/core/src/tools/tools.ts`
