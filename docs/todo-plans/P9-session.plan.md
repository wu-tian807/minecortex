---
name: "P9: Session 管理"
order: 9
overview: "JSONL 持久化 + 多模态内容存储(小媒体内联/大媒体文件引用) + 三层压缩(micro/auto/compact) + contextWindow 联动 + compact 工具 + 用户命令系统。"
depends_on: ["P1", "P7"]
unlocks: []
parallel_group: "phase-3"
todos:
  - id: session-manager
    content: "新建 src/session/session-manager.ts — SessionManager 类: JSONL读写 + 多模态存储(image内联/image_ref引用) + resume逻辑"
  - id: micro-compact
    content: "实现微压缩(每轮turn后): 保留最近 keepToolResults 个 tool_result, 旧的替换占位符 + 多模态清理(keepMedias)"
  - id: auto-compact
    content: "实现自动压缩(token>60%contextWindow): 摘要旧70%+保留新30% + repairToolPairing配对修复"
  - id: compact-tool
    content: "新建 tools/compact.ts — 手动触发压缩 + claude-code风格结构化摘要(Task Overview/Current State/Key Discoveries/Next Steps)"
  - id: tool-result-guard
    content: "实现 tool_result 单条上限保护: 超过contextWindow 50%时头70%+尾20%截断"
  - id: command-parser
    content: "新建 src/core/command-parser.ts — /<tool-name> <brain_id|all> -param value 语法解析"
  - id: stdin-command
    content: "修改 subscriptions/stdin.ts — 检测 / 前缀分流到命令解析器"
  - id: synthetic-message
    content: "用户命令执行时生成 synthetic assistant message 保证 LLM API 消息格式正确"
  - id: response-api-state
    content: "session.json 元数据增加 responseApi 状态字段(lastResponseId/provider), agent loop 调用 Response API 后更新, previousResponseId 失效时自动降级为全量 chatStream"
  - id: brain-session
    content: "修改 src/core/brain.ts — 持有 SessionManager, 替换内存 sessionHistory"
---

# P9: Session 管理

## 目标

实现完整的 Session 持久化 + 三层压缩 + 用户命令系统。

## 依赖

- P1（LLMResponse.usage 字段用于 token 累计）
- P7（contextWindow 阈值需要 token 估算 + Pipeline budget 协作）

## Session 目录结构

```
brains/<id>/
├── session.json             ← 当前活跃 session 指针
│   { "currentSessionId": "s_1709123456" }
└── sessions/
    └── <sid>/
        ├── messages.jsonl   ← 完整消息（文本+小媒体内联+大媒体引用）
        ├── qa.md            ← 人可读问答记录（P5）
        └── medias/          ← 大媒体文件存储
            ├── t3_screenshot.png
            └── t5_game_view.png
```

## 多模态持久化

```
小媒体（< 50KB）    → base64 内联存入 JSONL（type: "image"）
大媒体（>= 50KB）   → 保存到 medias/ 目录，JSONL 存路径引用（type: "image_ref"）
网络媒体（URL 来源） → 下载到 medias/，JSONL 存本地路径引用
```

Resume 时 `image_ref` 检查文件存在性，丢失则降级为 `[Image: 原文件已丢失]`。

## 三层压缩

### Layer 1: 微压缩（每轮 turn 后自动）

- 保留最近 `keepToolResults`（默认5）个 tool_result 原样，更早的替换为 `[Previous: used {toolName}]`
- 保留最近 `keepMedias`（默认-1=无限）个含媒体的消息，超出的删除 medias/ 文件
- 当前 turn 内产生的始终保留

### Layer 2: 自动压缩（token > 60% contextWindow）

- 摘要旧 70% + 保留新 30%
- 修复配对完整性（repairToolPairing）
- 原始 messages.jsonl 归档为 `.bak`
- 摘要格式：Task Overview / Current State / Key Discoveries / Next Steps / Context to Preserve

### Layer 3: 手动压缩（compact 工具）

```
compact() → { tokensBefore, tokensAfter, summaryTokens }
```

## Tool 配对修复

```typescript
function repairToolPairing(messages: LLMMessage[]): LLMMessage[] {
  // Orphaned tool_result（无对应 tool_call）→ 删除
  // Orphaned tool_call（无对应 tool_result）→ 添加 synthetic error result
  return repaired;
}
```

## 用户命令系统

**语法**：`/<tool-name> <brain_id|all> -param1 <value> -param2 <value>`

```
/send_message planner -content "开始建造房子"
/compact responder
/subscribe all -name heartbeat
```

**处理流程**：

```
stdin 检测 / 前缀 → 命令解析器 → 生成 synthetic assistant message → 执行工具 → tool_result
```

Synthetic message 保证 JSONL 中的消息格式与 LLM 自主产生的完全一致。

## Response API 状态（与 P1 联动）

### session.json 扩展

Response API 的 `lastResponseId` 存储在 session 元数据中，不进 brain_board：

```json
{
  "currentSessionId": "s_1709123456",
  "responseApi": {
    "lastResponseId": "resp_abc123",
    "provider": "openai"
  }
}
```

### 使用流程

1. Agent loop 检测 provider 是否支持 Response API（`provider.supportsResponseAPI === true`）
2. 如果支持且 session.json 有 `responseApi.lastResponseId`，调用 `chatResponseStream()` 增量发送
3. 调用成功后更新 `responseApi.lastResponseId` 为返回的新 `responseId`
4. 如果 `previousResponseId` 失效（服务端返回 400/404），自动降级：
   - 清除 `responseApi` 字段
   - 回退到全量 `chatStream()` 发送完整 history
5. 新建 session 时清除 `responseApi` 字段

### 为什么不存 brain_board

`brain_board` 是 per-brain 的跨脑共享 KV 存储，用于不同脑区间的消息传递。
`lastResponseId` 是 session 级状态，与特定会话绑定，应跟随 session 生命周期管理。

## brain.json session 配置

```json
{
  "session": {
    "keepToolResults": 5,
    "keepMedias": -1
  }
}
```

## 涉及文件

| 操作 | 文件 |
|------|------|
| 新建 | `src/session/session-manager.ts` |
| 新建 | `src/session/compaction.ts` |
| 新建 | `tools/compact.ts` |
| 新建 | `src/core/command-parser.ts` |
| 修改 | `subscriptions/stdin.ts` |
| 修改 | `src/core/brain.ts` |

## 参考实现

- `references/agentic_os/src/core/context-manager.ts` — 三层压缩
- `references/openclaw/src/agents/session-transcript-repair.ts` — repairToolPairing
- `references/openclaw/src/agents/compaction.ts` — 智能裁剪
