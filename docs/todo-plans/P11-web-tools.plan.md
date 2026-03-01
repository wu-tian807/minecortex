---
name: "P11: Web/Browser 工具"
order: 11
overview: "web_search(Tavily默认) + web_fetch(HTTP GET+HTML转文本) + browser(后期可选, CDP直连)。web_search 和 web_fetch 为中优先级核心工具，browser 为后期扩展。"
depends_on: ["P0"]
unlocks: []
parallel_group: "phase-1"
todos:
  - id: web-search
    content: "新建 tools/web_search.ts — Tavily Search API(默认, search_depth:advanced) + DuckDuckGo HTML抓取(无API key时降级) + 可注入 WebSearchProvider"
  - id: web-fetch
    content: "新建 tools/web_fetch.ts — HTTP GET + readability HTML转文本 + 内容长度限制(80K字符) + 错误处理"
  - id: browser
    content: "(后期) 新建 tools/browser.ts — 启动/连接 CDP(Chrome remote-debugging-port:9222) + navigate/screenshot/evaluate 基础操作"
---

# P11: Web/Browser 工具

## 目标

提供网络信息获取能力：搜索、网页读取、浏览器控制。
`web_search` 和 `web_fetch` 为中优先级核心工具，`browser` 为后期扩展。

## 依赖

- P0（ToolDefinition / input_schema 类型）

## 可并行

与 P1-P6 完全并行（仅依赖 P0 类型定义）。

## web_search

### Tavily 搜索（默认）

```typescript
// tools/web_search.ts
{
  name: "web_search",
  description: "搜索网络获取实时信息",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "搜索关键词" },
      max_results: { type: "number", description: "最大结果数(默认5)" },
    },
    required: ["query"],
  },
}
```

返回结构：
```typescript
{ results: [{ title: string, url: string, snippet: string, content?: string }] }
```

### 降级策略

```
1. Tavily Search API（默认，需要 TAVILY_API_KEY）
2. DuckDuckGo HTML 抓取（无 API key 时降级，无需认证）
3. 自定义 WebSearchProvider（可通过配置注入）
```

API key 来源：`process.env.TAVILY_API_KEY` 或 `brain.json` 的 `env` 字段。

## web_fetch

```typescript
// tools/web_fetch.ts
{
  name: "web_fetch",
  description: "获取网页内容并转换为文本",
  input_schema: {
    type: "object",
    properties: {
      url: { type: "string", description: "目标 URL" },
      max_length: { type: "number", description: "最大字符数(默认80000)" },
    },
    required: ["url"],
  },
}
```

实现要点：
- HTTP GET + 跟随重定向
- HTML → 纯文本转换（使用 readability 或类似库提取正文）
- 内容长度限制（默认 80K 字符，超出时截断 + 提示）
- 错误处理（超时、404、非 HTML 内容等）

返回结构：
```typescript
{ content: string, url: string, length: number, truncated: boolean }
```

## browser（后期可选）

**核心设计：Python + WebSocket 直连 CDP**

不构建重量级浏览器工具链，框架仅提供轻量 `browser` 工具：

1. 启动 / 连接 CDP 目标（Chrome `--remote-debugging-port=9222`）
2. 暴露基础操作（`navigate`, `screenshot`, `evaluate`）
3. 返回截图 + 页面可访问性树

复杂的浏览器自动化鼓励通过 bash 工具执行 Python CDP 脚本实现。
固定操作可固化为 skills 文件，模型通过 `read_skill` 获取步骤后用 bash 执行。

## 涉及文件

| 操作 | 文件 |
|------|------|
| 新建 | `tools/web_search.ts` |
| 新建 | `tools/web_fetch.ts` |
| 新建 | `tools/browser.ts`（后期） |

## 参考实现

- Agentic OS web_search: `references/agentic_os/src/tools/web-search.ts` — 降级策略
- Agentic OS web_fetch: `references/agentic_os/src/tools/web-fetch.ts` — HTML 转文本 + 80K 限制
- 调研文档 3.11 节 — 完整设计和 CDP 方案
