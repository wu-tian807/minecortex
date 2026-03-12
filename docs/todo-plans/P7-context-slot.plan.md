---
name: "P7: ContextSlot 系统"
order: 7
overview: "实现 Slot 化的 LLM 上下文管理 — slot-loader + SlotFactory + SlotRegistry + Prompt Pipeline(Resolve→Filter→Sort→Render→Budget) + Event Router + 动态 Slot API。directives/skills/soul/focus 全部由 Slot factory 管理。含 Skills 完整实现(扫描+read_skill工具)、Focus 工具、Soul.md 格式规范。"
depends_on: ["P3", "P4"]
unlocks: ["P9", "P10"]
parallel_group: "phase-2"
todos:
  - id: slot-loader
    content: "新建 src/loaders/slot-loader.ts — 继承 BaseLoader(P3), 实现 SlotFactory 的发现-过滤-加载-注册"
  - id: slot-registry
    content: "新建 src/context/slot-registry.ts — SlotRegistry 类: register/update/remove/get + renderSystem()/renderMessages()"
  - id: prompt-pipeline
    content: "新建 src/context/prompt-pipeline.ts — 五阶段: Resolve(惰性求值) → Filter(condition) → Sort(order) → Render(模板变量) → Budget(priority裁剪)"
  - id: event-router
    content: "新建 src/context/event-router.ts — 事件按source路由到message Slot(events:stdin, events:bus等)"
  - id: dynamic-slot
    content: "在 SlotRegistry 中实现 DynamicSlotAPI(register/update/release) — 工具临时注入 system prompt"
  - id: slot-soul
    content: "新建 slots/soul.ts — 读 soul.md → 1个 system Slot"
  - id: slot-directives
    content: "新建 slots/directives.ts — 扫描 directives/*.md + brains/<id>/directives/*.md → N个 system Slot(内覆盖外)"
  - id: slot-tools
    content: "新建 slots/tools.ts — 工具定义列表 → 1个 system Slot"
  - id: slot-skills
    content: "新建 slots/skills.ts — 递归扫描三层 `**/SKILL.md`，只提取 name/description 并生成摘要列表注入 system Slot"
  - id: skill-read-tool
    content: "新建 tools/read_skill.ts — 按 skill 名称读取完整 SKILL.md 与 supporting files 清单，具体文件继续走通用 read_file / shell"
  - id: slot-context-file
    content: "新建 slots/context-file.ts — focus 目录 AGENTS.md/README.md + 目录结构 → 1个 dynamic Slot"
  - id: focus-tool
    content: "新建 tools/focus.ts — 设置当前关注目录/文件, 触发 context-file slot 更新(release旧slot + register新slot)"
  - id: soul-format
    content: "明确 soul.md 四段式格式规范(身份/职责/约束/关系), slots/soul.ts 按此格式解析"
  - id: slot-events
    content: "新建 slots/events.ts — 事件类型 → N个 message Slot"
  - id: migrate-context-engine
    content: "重写 src/context/context-engine.ts — 从硬编码5层改为调用 Pipeline renderSystem()+renderMessages()"
  - id: delete-directive-loader
    content: "删除 src/loaders/directive-loader.ts — 被 slots/directives.ts factory 替代"
  - id: migrate-directives
    content: "将 directives/*.ts+*.md 配对模式改为纯 *.md 文件(删除 .ts config)"
  - id: brain-integrate
    content: "修改 src/core/brain.ts — 持有 SlotRegistry, process()中调用 Event Router + Pipeline + flush"
---

# P7: ContextSlot 系统

## 目标

实现统一的 LLM 上下文管理系统，替代硬编码的 5 层 context-engine。

## 依赖

- P3（FSWatcher + BaseLoader）— slot-loader 继承 BaseLoader，fs-watcher invalidate
- P4（brain_board）— SlotContext 和 SourceContext 包含 brainBoard 引用

## 可并行

P7 和 P8 可并行（都依赖 P3）。

## 核心架构

### 三类 Slot Kind

| kind | 注入位置 | 典型 factory |
|------|---------|-------------|
| `system` | system prompt（固定，fs-watcher 更新） | soul, directives, tools, skills |
| `dynamic` | system prompt（工具/事件驱动增删改） | context-file, 工具运行时注册 |
| `message` | messages 数组（EventRouter 每 turn 写入） | events |

### SlotFactory 接口

```typescript
export type SlotFactory = (ctx: SlotContext) => ContextSlot | ContextSlot[];

// directives.ts 示例: 返回 N 个子 Slot
const create: SlotFactory = (ctx) => {
  const files = scanAndMerge(join(ROOT, 'directives'), join(ctx.brainDir, 'directives'));
  return files.map((file, i) => ({
    id: `directive:${file.name}`,
    kind: 'system' as const,
    order: 20 + i,
    priority: 9,
    content: () => readFileSync(file.path, 'utf-8'),
    version: 0,
  }));
};
```

### Prompt Assembly Pipeline

```
SlotRegistry(所有 Slot)
  → Resolve(惰性求值: string 直接用, 函数调用取值)
  → Filter(condition() 为 false 的跳过)
  → Sort(按 order 排序)
  → Render(模板变量 ${VAR} 替换)
  → Budget(token 超预算时按 priority 从低到高裁剪)
  → System Prompt(system+dynamic kind) + Messages Array(message kind)
```

### Budget 裁剪优先级

| priority | Slot 类型 | 裁剪策略 |
|----------|---------|---------|
| 10 | soul | 永不裁剪 |
| 9 | rules, behavior | 永不裁剪 |
| 8 | board, tools | 很少裁剪 |
| 7 | skills | 超预算时截断为摘要 |
| 5 | context-file | 超预算时截断（头+尾） |
| 3 | runtime, 动态 | 超预算时移除 |

### 动态 Slot API（通过 ToolContext）

```typescript
// 任何工具都可以临时向 system prompt 注入信息
ctx.slot.register("thought:t1", "▶ observe: 侦察北方地形 (32s)");
ctx.slot.update("todos", renderTodos(items));
ctx.slot.release("thought:t1");
```

### 三 Loader 对称设计

| 维度 | subscription-loader | tool-loader | slot-loader |
|------|-------------------|------------|------------|
| 全局目录 | `subscriptions/` | `tools/` | `slots/` |
| 脑专属 | `brains/<id>/subscriptions/` | `brains/<id>/tools/` | `brains/<id>/slots/` |
| Factory 类型 | `EventSourceFactory` | `ToolFactory` | `SlotFactory` |
| brain.json 键 | `subscriptions` | `tools` | `slots` |

## Skills 系统（完整实现）

### skills 扫描

`slots/skills.ts` 递归扫描三层目录下的 `**/SKILL.md`：

- `skills/**/SKILL.md`
- `bundle/skills/**/SKILL.md`
- `bundle/brains/<id>/skills/**/SKILL.md`

启动时只提取轻量 metadata 注入摘要，正文与 supporting files 按需读取。当前 frontmatter 只需要 `name` 和 `description`。`glob/globs` 不再属于 skill schema。

```yaml
---
name: typescript-coding
description: TypeScript 编码规范与最佳实践
---
（Skill 完整内容...）
```

生成摘要列表注入 system prompt Slot：

```
Available Skills:
- typescript-coding: TypeScript 编码规范与最佳实践
- python-coding: Python 编码规范
- minecraft-api: Minecraft Bot API 参考
```

### read_skill 工具

LLM 看到摘要后可按需调用 `read_skill({ name: "typescript-coding" })` 读取完整内容和 supporting file 索引；如需继续读取 `references/`、`scripts/`、`assets/` 等资源，可直接使用通用 `read_file` 工具，执行脚本则继续走 shell。

```typescript
// tools/read_skill.ts
{
  name: "read_skill",
  description: "读取指定 skill 的完整内容以及 supporting files 清单",
  input_schema: {
    type: "object",
    properties: { name: { type: "string", description: "skill 名称" } },
    required: ["name"],
  },
  execute: async (args, ctx) => {
    const skill = loadSkillByName(ctx.pathManager, ctx.brainId, args.name);
    return renderSkill(skill);
  },
}
```

## Focus 工具 + Context-File Slot

### focus 工具

`tools/focus.ts` 设置当前关注目录/文件，触发 `context-file` dynamic slot 更新：

```typescript
// tools/focus.ts
execute: async (args, ctx) => {
  ctx.slot.release("context-file:current");
  const content = buildFocusContext(args.path); // AGENTS.md + README.md + 目录结构
  ctx.slot.register("context-file:current", content);
  return `Focus set to: ${args.path}`;
}
```

### context-file slot

`slots/context-file.ts` 读取 focus 目标目录下的：
- `AGENTS.md`（如果存在）
- `README.md`（如果存在且无 AGENTS.md）
- 目录结构树（ls-tree 格式）

Focus 变更时自动 release 旧 slot + register 新 slot。

## Soul.md 格式规范

`slots/soul.ts` 按四段式格式解析 `soul.md`：

```markdown
# 身份
你是 MineCortex 的 Listener 脑区...

# 职责
- 监听玩家消息
- 解析意图

# 约束
- 不主动发起对话
- 响应延迟 < 2s

# 关系
- 向 Responder 发送解析后的意图
- 从 Planner 接收任务指令
```

四段可选，缺失时跳过。解析后注入为 priority=10 的 system Slot（永不裁剪）。

## Directive 迁移

旧模式（.ts config + .md 内容）→ 新模式（纯 .md 文件，由 slots/directives.ts 扫描）：

```
旧: directives/identity.ts + directives/identity.md
新: directives/rules.md (框架认知) + directives/behavior.md (行为准则)
```

## 涉及文件

| 操作 | 文件 |
|------|------|
| 新建 | `src/loaders/slot-loader.ts` |
| 新建 | `src/context/slot-registry.ts` |
| 新建 | `src/context/prompt-pipeline.ts` |
| 新建 | `src/context/event-router.ts` |
| 新建 | `slots/soul.ts`, `slots/directives.ts`, `slots/tools.ts` |
| 新建 | `slots/skills.ts`, `slots/context-file.ts`, `slots/events.ts` |
| 新建 | `tools/read_skill.ts` |
| 新建 | `tools/focus.ts` |
| 重写 | `src/context/context-engine.ts` |
| 删除 | `src/loaders/directive-loader.ts` |
| 删除 | `directives/*.ts` (保留/重写 .md 文件) |
| 修改 | `src/core/brain.ts` |
