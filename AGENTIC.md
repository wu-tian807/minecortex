# AGENTIC.md — MineClaw 框架规范（必读）

> MineClaw 是 Minecraft 游戏 AI 的"大脑侧"框架。
> MineAvatar (Java) 是"身体"，MineClaw (TypeScript) 是"智能"。
> 两侧通过框架无关的 WebSocket JSON 协议连接。
> 详细设计见 [evolution-design.md](../evolution-design.md)。

---

## 1. 核心信念

**目录即大脑。** 所有状态都在文件系统中，`ls` 可见，`git` 可追溯。

```
brains/       → ls 就知道有哪些脑
skills/       → ls 就知道会什么技能
genes/        → ls 就知道学到了什么经验
logs/         → tail 就知道刚才做了什么
```

删目录 = 遗忘。拷目录 = 克隆。`git push` = 灵魂备份。

**身体与大脑分离。** MineAvatar 不含任何策略，MineClaw 不含任何执行。
分界线是 WebSocket JSON — 任何能发 JSON 的系统都能当大脑。

**三速分层。** 不同层运行在不同时钟频率上，互不阻塞：

```
脑层 (TypeScript, 秒~分钟级)  — 每个脑按自己的心跳节奏运行
执行层 (Java, tick 级)         — BT 遍历 / 原子动作 / 事件检测
```

脑层内部不再硬分"计算脑"和"意识脑"——每个脑可以同时拥有
`src/`（脚本能力）和 `model`（LLM 意识），两者正交组合。

---

## 2. 多脑系统

### Brain = 目录

每个 Brain 是一个自治单元，完整自包含在 `brains/<id>/` 目录中。
**Scheduler 启动时扫描 `brains/` 目录自动发现所有脑区**——不需要中心化注册表。

`mineclaw.json` 仅存放全局默认值（可选）：

```jsonc
{
  "defaults": {
    "model": "gemini-2.5-flash"   // brain.json 未指定 model 时的 fallback
  }
}
```

脑的一切配置都在自己的 `brain.json` 里：

```jsonc
// brains/social/brain.json
{
  "model": "gemini-2.5-flash",              // 哪个 LLM（省略 = 脚本脑）
  "subscriptions": { "default": "none" },   // 能力选择器
  "tools":         { "default": "all" }
}
```

### 两个正交开关

每个脑有两个独立的能力维度：

| 开关 | 有 | 无 |
|------|----|----|
| `brain.json` → `model` | LLM 意识开启 → agentic loop | 无 LLM，纯脚本驱动 |
| `brains/<id>/src/` | 有可执行脚本代码 | 无脚本，纯 LLM 决策 |

两者**正交组合**，产生三种合法模式：

| 模式 | model | src/ | 心跳做什么 | 例子 |
|------|-------|------|-----------|------|
| **纯脚本** | 无 | 有 | 运行 `src/` 入口函数 | Planner、Executor |
| **纯意识** | 有 | 无 | LLM agentic loop | Intent、Social |
| **意识+脚本** | 有 | 有 | LLM 可调用自己的脚本作为工具 | Reflect (进化后) |

**纯脚本脑**不是特殊类型——只是还没开启 LLM 的脑。
**意识脑**可以在 evolve 模式下给自己写脚本，获得程序化能力。

**一切属于脑的东西，都放在脑的目录里。** 顶层 `src/` 只有框架抽象
（Brain 基类、BrainBus、Scheduler、ContextEngine 等），不含任何脑的具体逻辑。

### Scheduler 启动逻辑

```typescript
// 扫描 brains/ 目录，读取每个脑的 brain.json
for (const id of await discoverBrains()) {
  const brainJson = loadBrainJson(`brains/${id}/brain.json`);
  const hasSrc = existsSync(`brains/${id}/src/`);
  const model = brainJson.model ?? globalConfig.defaults?.model;

  if (model && hasSrc)   → HybridBrain(id)    // LLM + 脚本作为工具
  if (model && !hasSrc)  → ConsciousBrain(id)  // 纯 LLM
  if (!model && hasSrc)  → ScriptBrain(id)     // 纯脚本
  // !model && !hasSrc → 跳过并报警
}
```

### `brains/*/src/` 访问规则

- **默认模式**: 任何 LLM 都**不可读写**任何 `brains/*/src/`
- **evolve 模式**: ReflectBrain 可提议修改 → IntentBrain 审批
- 意识脑给自己写 `src/` = 给自己造工具 → 下次心跳自动可用

### 初始五脑

| Brain | model | src/ | 频率 | 职责 |
|-------|-------|------|------|------|
| **Planner** | — | ✓ | 1~5s | HTN 分解 + GOAP 搜索 + BT 组装 |
| **Executor** | — | ✓ | 事件 | Safety 拼接 + BT 推送 + ActionResult 收集 |
| **Intent** | ✓ | — | 10min | 意图管理 + 目标优先级 + 进化审批 |
| **Social** | ✓ | — | 事件 | 对话回复 + 指令解析 + 社交行为 |
| **Reflect** | ✓ | — | 30min | 失败诊断 + Skill 创作/修改 + 脑区进化 |

以上是初始脑区，不是上限。evolve 模式下可长出新脑、可给已有脑加 `src/` 或 `model`。

---

## 3. 脑间通信

脑之间**绝不共享 LLM Session**。跨脑信息流动只有三条路径：

| 路径 | 模式 | 内容 | 类比 |
|------|------|------|------|
| **BrainBus** | 消息队列 | 指令/请求/结果/审批 | agentic_os MessageBus |
| **Notice** | 事件 push | 世界事件的语义化信号 | TriggerQueue |
| **文件读** | pull | 其他脑的 state.json / skills / logs | 文件系统即共享状态 |

没有第四条路。不存在 Blackboard，不存在"隐式共享上下文"。
每个脑的 `state.json` 就是它的公开状态——其他脑可读，不可写。

### BrainBus — 对齐 agentic_os MessageBus

和 agentic_os 的 MessageBus 相同语义：

```typescript
bus.send(from, to, content, summary)   // 点对点消息
bus.broadcast(from, content, summary)  // 广播
bus.drain(brainId) → Message[]         // 下次心跳时消费队列
bus.pending(brainId) → number          // 查看待处理消息数
```

典型消息流：

```
正常: Social ──command──→ Intent ──intent──→ Planner ──bt──→ Executor
失败: Executor ──failed──→ Planner → 重搜 / → Intent
进化: Reflect ──request_approval──→ Intent ──approved/rejected──→ Reflect
```

所有消息自动记录到 `logs/brain-messages.jsonl`。

### request_approval — 对齐 agentic_os 审批模式

进化操作走 BrainBus 的 `request_approval` 消息（不是独立机制）：

1. ReflectBrain 写 `brains/reflect/proposals/<id>.md` 描述变更计划
2. 通过 BrainBus 发送 `request_approval` 给 IntentBrain（附 proposal 路径）
3. ReflectBrain **停止并等待**（不继续执行）
4. IntentBrain 下次心跳时审阅 → `approved` / `rejected` 回复
5. ReflectBrain 收到 `approved` → 执行变更；收到 `rejected` → 放弃

### task-board.md — 对齐 agentic_os TaskBoard

框架自动生成 `task-board.md`（人可读，脑可读），实时追踪全部脑的活动：

```markdown
# Task Board
## Active
- [▶ intent] 意图管理 | model: gemini-2.5-flash | 3 calls | 2m15s
- [▶ planner] HTN 分解 | script | 142 calls | 8s

## Completed
- [✓ reflect] Skill 诊断 | model: claude-4-sonnet | 12 calls | 1m30s
  Result: 优化了 mine_diamond skill 的 BT 模板
```

### Agent Loop — 对齐 agentic_os

每个有 LLM 的脑拥有自己的 async while 循环（对齐 agentic_os 的 agent loop）：

```typescript
// brain.run(signal) — agentic_os 风格
while (!signal.aborted) {
  const trigger = await queue.waitForEvent(signal);   // 阻塞等待
  if (trigger.priority > 0) await sleep(coalesceMs);  // 合并窗口
  const events = queue.drain();                        // 按 priority 排序
  await this.process(events);                          // LLM + tool loop
}
```

| 组件 | 职责 |
|------|------|
| **EventQueue** | 事件累积 (push/drain/pending) + 阻塞等待 (waitForEvent) |
| **brain.run()** | agent loop: wait → coalesce → drain → process → loop |
| **Scheduler** | 发现脑 → 接线 → 启动 loop → 关闭 |

- 订阅配置 (`brain.json` subscriptions) 是唯一的事件过滤层
- 无 `shouldWake` / `WakePolicy` — 收到事件即处理
- `coalesceMs` 在 `brain.json` 中配置，控制合并窗口
- `priority` 字段控制排队顺序：0=immediate, 1=normal, 2=low
- priority 0 跳过 coalesce 窗口，立即处理

---

## 4. 状态与 Session

每个脑在自己目录下维护 `state.json`——脑的**工作记忆**，只有自己可写。
内容因脑的职责而不同：

| 脑 | `state.json` 里存什么 |
|----|-----------------------|
| Intent | 当前意图、目标优先级队列、待审批提议列表 |
| Social | 当前对话对象、最近交互摘要、关系状态 |
| Reflect | 当前分析焦点、进化候选项、审计周期进度 |
| Planner | 当前 HTN 分解栈、GOAP 搜索状态、活跃目标 |
| Executor | 当前 BT 推送状态、重试计数、失败队列 |

跨脑状态共享不需要 Blackboard——文件系统就是共享状态：

```
World Snapshot  ← MineAvatar 推送, 所有脑可读, 无人可写
Brain state.json ← 每个脑自己写, 其他脑可读 (cat brains/intent/state.json)
BrainBus        ← 消息队列 (send / drain / pending)
task-board.md   ← 框架自动生成, 全局可读
```

有 LLM 的脑各自拥有独立 Session（防上下文污染、model 可不同、token 独立）。
ContextEngine 按脑的职责裁剪上下文窄切面。
压缩三层：微压缩(摘要行) → 自动压缩(LLM 摘要) → 记忆刷写(`memory/` 持久化)。

---

## 5. ContextEngine 与提示词系统

每个有 LLM 的脑，心跳时由 ContextEngine 组装独立的 System Prompt。
对齐 agentic_os 的分层组装 + 条件加载，借鉴 openclaw 的截断保护。

### 分层组装

System Prompt 由 6 层按序拼接，soul 层可热替换而不重建其他层：

| 层 | 来源 | 内容 |
|----|------|------|
| **Soul** | `brains/<id>/soul.md` | 脑的身份/人格/行为准则 |
| **Runtime** | 框架自动生成 | 模型名、脑 ID、时间、世界摘要 |
| **Skills** | `brains/<id>/skills/` + `skills/` | 技能摘要列表 (~30 tokens/条) |
| **Directives** | `brains/<id>/directives/` | 行为指令模块 (条件加载) |
| **Tools** | `brains/<id>/tools/` + `tools/` | 可用工具列表 + 描述 |
| **State** | `brains/<id>/state.json` + Notice 队列 | 当前工作记忆 + 待处理信号 |

```typescript
// soul 层热替换 (evolve 修改 soul.md 后即时生效)
const rebuildPrompt = (newSoul: string) => {
  soulBlock = newSoul;
  return [soulBlock, ...otherLayers].filter(Boolean).join('\n\n');
};
```

### 指令模块 (Directives)

对齐 agentic_os 的 `.ts` + `.md` 成对文件设计：

```
brains/intent/directives/
  priority-rules.ts      ← 注册配置 (order, condition)
  priority-rules.md      ← 模板内容 (YAML frontmatter + markdown)
  approval-protocol.ts
  approval-protocol.md
```

每个模块自包含：

```typescript
// priority-rules.ts
export const section: SectionConfig = {
  name: 'priority-rules',
  order: 2,
  condition: (ctx) => ctx.hasPendingIntents,
};
```

```markdown
<!-- priority-rules.md -->
---
name: priority-rules
variables: [CURRENT_INTENTS, WORLD_STATE]
---
# 意图优先级规则
当前活跃意图：${CURRENT_INTENTS}
...
```

模板变量用 `${VAR_NAME}` 占位符，ContextEngine 渲染时替换。
每个 directive 的 `condition()` 决定是否加载——不同状态下脑看到不同的指令集。

### 三层上下文压缩

长时运行的游戏 AI 会快速膨胀上下文。三层递进压缩：

| 层 | 时机 | 策略 | 信息损失 |
|----|------|------|---------|
| **微压缩** | 每次 LLM 调用前 | 旧 tool_result → `[Previous: used X]`，保留最近 N 个 | 极小 |
| **自动压缩** | token 超阈值 | LLM 生成摘要替换历史，原文存 `sessions/transcript_*.jsonl` | 中等 |
| **记忆刷写** | 自动压缩时 | 重要发现写入 `memory/` 持久化，跨 session 保留 | 零(持久化) |

微压缩是最关键的一层——游戏 AI 每秒都在查血量、查位置、查物品，
旧的 tool_result 迅速膨胀但价值衰减，用占位符替换后上下文保持精简。

### 截断保护 (借鉴 openclaw)

- **单个 tool_result 上限**: ≤ 50% 上下文窗口（防止一次 read_file 吃光 context）
- **大文件截断**: 头部 70% + 尾部 20%（中间丢弃，因为首尾通常最重要）
- **Skill 按需加载**: System Prompt 里只放摘要，完整内容走 `read_skill` 工具

### 模型适配器

不同脑可用不同模型。统一 `LLMProvider` 接口 + 适配器注册制：

```typescript
registerProvider('gemini', (opts) => new GeminiProvider(opts));
registerProvider('anthropic', (opts) => new AnthropicProvider(opts));
registerProvider('openai-compat', (opts) => new OpenAICompatProvider(opts));
```

`brain.json` 中的 `model` 字段自动路由到对应适配器。
加新模型 = 写一个适配器 + 注册一行。

---

## 6. Tools 与 Skills

### 两层查找：脑内优先，全局兜底

Tools 和 Skills 都遵循同一套查找规则：

```
1. brains/<id>/tools/   →  脑专属工具
2. tools/               →  全局共享工具
3. brains/<id>/skills/  →  脑专属技能
4. skills/              →  全局共享技能
```

脑内定义 > 全局定义。同名时脑内覆盖全局（类似 PATH 查找）。

### Tool = LLM 可调用的能力

Tool 是有 LLM 的脑在 agentic loop 中可调用的函数定义。
脚本脑不需要 Tool 定义（它的能力写在 `src/` 里）。

### Skill = 可复用的知识单元

Skill 不限于一种格式——任何可复用的策略/知识/模板都是 Skill：

| 类型 | 格式 | 例子 |
|------|------|------|
| BT 子树模板 | `.json` | 挖矿行为树、战斗行为树 |
| HTN 策略 | `.md` / `.ts` | "获取钻石"的分解路径描述 |
| 通用指南 | `.md` | 建筑美学原则、交易策略 |
| GOAP 动作集 | `.ts` | 一组相关动作的 cost 定义 |

### 两层加载（借鉴 agentic_os）

- **Layer 1**: System Prompt 中每个 Skill 只放名称 + 描述 + 成功率 (~30 tokens)
- **Layer 2**: LLM 调用 `read_skill` 按需加载完整内容

### Skill 进化

ReflectBrain 审查 ActionRecord → 识别低成功率 Skill → 修改内容
→ 版本递增 → A/B 测试 → 采纳或回滚。

### Safety 子树

Safety 不是独立 Brain，而是 BT Root Selector 的最高优先级子树。
每 tick 自动优先检查（血量低→吃→逃）。可由 ReflectBrain 提议修改，
需 IntentBrain 审批。

---

## 7. 进化与 evolve 模式

借鉴 agentic_os: 目录即大脑 → 创建新目录 = 长出新脑区。

### 进化手段

| 手段 | 做什么 | 例子 |
|------|--------|------|
| 改数据文件 | 调参数、改知识 | GOAP cost、HTN 方法、Safety 规则 |
| 改 soul.md | 改脑的人格/指令 | 让 Intent 更激进 |
| 写 `src/` | 给脑加脚本能力 | Reflect 给自己写分析工具 |
| 加 `model` | 给脚本脑开意识 | 给 Planner 加 LLM 辅助决策 |
| 新建脑目录 | 长出新脑区 | 创建 `brains/explorer/` |
| 休眠脑 | 停心跳，保留目录 | ROI 低的脑暂停 |

所有进化操作走 `request_approval` 消息（见 §3 通信章节）：
ReflectBrain 写 proposal → BrainBus 发审批请求 → IntentBrain 审批 → 执行或放弃。

### 权限控制

| 操作 | 默认模式 | evolve 模式 |
|------|---------|------------|
| 写自己的 state/memory/tools/skills | 可以 | 可以 |
| 读任何脑的数据文件 | 可以 | 可以 |
| 改数据文件 (htn-methods, cost, safety) | 禁止 | 提议 → 审批 |
| 改任何脑的 soul.md | 禁止 | 提议 → 审批 |
| 读/写任何 `brains/*/src/` | **禁止** | 提议 → 审批 + 人工确认 |
| 创建/休眠/删除脑区 | 禁止 | 提议 → 审批 |
| 修改 `src/` (框架代码) | **禁止** | **禁止**（人工维护） |

### 自然选择

有 LLM 的脑消耗 token。ReflectBrain 定期审计脑区 ROI
（唤醒次数 / 采纳率 / token 消耗）。ROI 过低 → 提议休眠。
目录保留（可恢复），Scheduler 停止心跳。

---

## 8. 目录结构

```
mineclaw/
├── AGENTIC.md
├── mineclaw.json              # 可选: 全局默认值 (fallback model 等)
├── task-board.md              # 框架自动生成, 全脑活动追踪
│
│   ── 全局能力池 (脑通过 brain.json 选择性启用) ──
│
├── subscriptions/             # 可插拔事件订阅源
│   ├── stdin.ts               #   终端输入
│   └── ...                    #   minecraft-chat.ts / websocket.ts (future)
├── tools/                     # 工具定义 (.ts 实现 + .md 描述, 成对)
│   ├── send_message.ts + .md  #   BrainBus 发消息
│   └── read_state.ts + .md    #   读取其他脑 state.json
├── skills/                    # 技能库 (BT 模板 / HTN 策略 / 指南, 多格式)
├── directives/                # 行为指令 (.ts 配置 + .md 模板, 成对)
│
│   ── 脑区 ──
│
├── brains/
│   │
│   ├── listener/              #   最小意识脑
│   │   ├── brain.json         #   ★ 必须: 启用 stdin 订阅 + 全局工具
│   │   ├── soul.md            #   必须 (有 model): 身份/人格
│   │   └── state.json         #   必须: 工作记忆
│   │
│   ├── responder/             #   最小意识脑
│   │   └── ...
│   │
│   └── planner/               #   复杂脑 (按需添加可选目录)
│       ├── brain.json         #   必须
│       ├── state.json         #   必须 (纯脚本脑无需 soul.md)
│       ├── src/               #   可选: 脚本代码 (默认 LLM 不可访问)
│       ├── tools/             #   可选: 脑专属工具 (覆盖同名全局)
│       ├── skills/            #   可选: 脑专属技能
│       ├── subscriptions/     #   可选: 脑专属订阅源
│       ├── directives/        #   可选: 脑专属指令
│       ├── memory/            #   可选: 长期记忆
│       └── sessions/          #   自动创建: LLM 会话历史
│
├── key/                       # API 密钥 (.gitignore)
│   └── llm_key.json
├── genes/                     # 基因库 (进化知识)
├── logs/                      # 行为日志 (JSONL)
│
└── src/                       # ★ 纯框架基础设施
    ├── core/                  #   Brain 基类 / BrainBus / EventBus / Scheduler
    ├── context/               #   ContextEngine / PromptAssembler
    ├── llm/                   #   LLMProvider / 适配器注册 / 模型路由
    └── loaders/               #   能力加载器 (读 brain.json, 合并全局+脑内)
```

### brain.json — 脑的完整配置 (目录即大脑的核心)

```jsonc
// brains/listener/brain.json
{
  "model": "gemini-2.5-flash",                           // 可选: LLM 模型
  "subscriptions": { "default": "none", "enable": ["stdin"] },
  "tools":         { "default": "all" },
  "skills":        { "default": "none" },
  "directives":    { "default": "all" }
}
// model 省略 → 使用 mineclaw.json defaults.model → 再省略 = 脚本脑
// default: "all" + disable: [...] = 全开, 选择性关闭
// default: "none" + enable: [...] = 全关, 选择性开启
// 脑内同名目录覆盖全局同名项
```

**关键约定:**
- `brain.json` + `state.json` 必须存在; `soul.md` 有 model 时必须
- 其他子目录全部可选，不存在则跳过，按需创建
- `brain.json` 有 `model` 的脑 → Scheduler 启动 agent loop
- 有 `src/` 的脑 → Scheduler 加载脚本入口
- `coalesceMs` 在 `brain.json` 中配置合并窗口（默认 300ms）
- 全局能力池 + brain.json 选用 + 脑内覆盖 = 三层能力解析
- 顶层 `src/` 只有框架抽象，零脑特定逻辑
- 新建脑 = 创建 `brains/<id>/` 目录 + brain.json + state.json (+ soul.md if model)

---

## 9. 文件规范

### 允许的文件类型

`.ts` · `.json` · `.md` · `.jsonl`

**禁止**: `.yaml` · `.toml` · `.env` · `.yml`

### 代码规模

- 单文件 ≤ 300 行
- 函数 ≤ 50 行
- 嵌套 ≤ 3 层

### @desc 注释

每个 `.ts` 文件第一行:

```typescript
// @desc <English, one line, ≤30 tokens>
```

`grep -r @desc src/ brains/*/src/` 获得全项目地图。

---

## 10. 核心概念速查

| 概念 | 一句话 |
|------|--------|
| **目录即大脑** | `brains/<id>/` = 一个完整自包含的脑区 |
| **两个开关** | `model`(LLM 意识) 和 `src/`(脚本能力) 正交组合 |
| **src/ 在脑里** | 脚本代码在 `brains/<id>/src/`, 顶层 `src/` 纯框架 |
| **三条路径** | BrainBus(消息路由) / EventQueue(事件累积) / 文件读(state.json) |
| **Agent Loop** | agentic_os 风格 while 循环: wait → coalesce → drain → process |
| **priority** | 0=immediate(跳过coalesce), 1=normal, 2=low; drain 按 priority 排序 |
| **无 Blackboard** | 文件系统即共享状态, `cat state.json` 即可读其他脑状态 |
| **Session 隔离** | 每个有 LLM 的脑独立 session, 绝不共享 |
| **6 层 Prompt** | Soul → Runtime → Skills → Directives → Tools → State |
| **条件指令** | `.ts` + `.md` 成对, `condition()` 按状态动态加载 |
| **三层压缩** | 微压缩(占位符) → 自动压缩(LLM 摘要) → 记忆刷写 |
| **适配器注册** | 统一 LLMProvider 接口, 不同脑可用不同模型 |
| **task-board.md** | 框架自动生成的活动看板, 对齐 agentic_os TaskBoard |
| **request_approval** | 进化审批走 BrainBus 消息, 对齐 agentic_os 审批模式 |
| **脑内 > 全局** | tools/ skills/ 脑内优先, 全局兜底 |
| **Skill = 知识** | BT 模板 / HTN 策略 / 通用指南, 不限格式 |
| **evolve 模式** | 写文件 = 长新脑 / 加 src/ / 加 model, 审批制 |
| **自然选择** | ROI 低的脑休眠, 有用的保留 |
| **进化纪律** | 一次只改一层, 有版本号, 可归因 |

---

> 详细设计 (原子动作 / BT 协议 / GOAP / HTN / 进化机制): [evolution-design.md](../evolution-design.md)
