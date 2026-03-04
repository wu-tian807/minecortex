# AIRI Minecraft Agent 调研报告

> 2025-03-05 | 仓库: [moeru-ai/airi](https://github.com/moeru-ai/airi) | 24.5k stars | 2825 commits

---

## 一、项目概况

AIRI 是一个"赛博生命容器"项目，目标是再创 Neuro-sama——一个能聊天、玩 Minecraft、玩 Factorio 的 AI 虚拟角色。项目是 **pnpm monorepo + Turbo**，主体为 TypeScript，Minecraft Agent 位于 `services/minecraft/`。

**技术栈**：
- Mineflayer + 6 个插件（pathfinder/pvp/collectblock/auto-eat/armor-manager/tool）
- xsAI（LLM 调用库，兼容 OpenAI API）
- Awilix（DI 容器）
- prismarine-viewer（3D 调试可视化）
- Zod（Action schema 校验）

---

## 二、架构：四层认知栈

AIRI 的 Minecraft Agent 采用 **感知 → 反射 → 意识 → 行动** 四层认知架构：

```
┌────────────────────────────────────────────────────────────┐
│ Perception Pipeline（感知层）                                │
│                                                            │
│  EventRegistry 监听 bot 事件                                │
│  → 发出 raw:modality:kind（如 raw:sighted:entity_moved）   │
│  → RuleEngine（YAML 规则）累积匹配                          │
│  → 发出 signal:*（如 signal:entity_attention）              │
└───────────────────────┬────────────────────────────────────┘
                        │ EventBus
┌───────────────────────▼────────────────────────────────────┐
│ Reflex Layer（反射层）                                      │
│                                                            │
│  ReflexManager 订阅 signal:*                               │
│  ReflexRuntime: 5 种模式（idle/work/wander/alert/social）  │
│  ReflexBehavior: when + score + run（如 idle-gaze）         │
│  → 选择性转发到 conscious:signal:*                          │
└───────────────────────┬────────────────────────────────────┘
                        │ conscious:signal:*
┌───────────────────────▼────────────────────────────────────┐
│ Conscious Layer（意识层 = Brain）                            │
│                                                            │
│  事件优先级队列（chat > perception > feedback）              │
│  buildUserMessage → LLM 调用                                │
│  LLM 输出 = JavaScript 代码                                │
│  → JavaScriptPlanner REPL 执行                             │
└───────────────────────┬────────────────────────────────────┘
                        │ use(toolName, params)
┌───────────────────────▼────────────────────────────────────┐
│ Action Layer（行动层）                                      │
│                                                            │
│  ActionRegistry + TaskExecutor                             │
│  同步/异步动作执行                                          │
│  动作队列（1 executing + 4 pending）                        │
│  反馈回传到 Brain                                          │
└────────────────────────────────────────────────────────────┘
```

### 对比 MineClaw 的六脑系统

| AIRI 层 | MineClaw 对应 | 差异 |
|---------|-------------|------|
| Perception | 感知脑 | AIRI 用 YAML RuleEngine 做信号累积；MineClaw 计划用 Slot+Subscription |
| Reflex | 执行脑（部分） | AIRI 有独立的反射层处理低层即时反应；MineClaw 可借鉴 |
| Conscious | 意识脑 | AIRI 单一 Brain；MineClaw 拆为意识脑+规划脑 |
| Action | Tool 层 | AIRI 是扁平 Action 列表；MineClaw 计划 Primitive→Tool→Skill 三层 |

---

## 三、核心设计模式

### 3.1 LLM 输出 = JavaScript（非 Function Calling）

这是 AIRI 最独特的设计。LLM 不返回 JSON tool_call，而是直接输出 **JavaScript 代码**，由 JavaScriptPlanner 在 VM 沙箱中执行：

```javascript
// LLM 的实际输出示例
const inv = query.inventory().summary(); inv
// 下一轮
const inv = prevRun.returnRaw;
await chat({ message: `I have: ${inv.map(i => `${i.count} ${i.name}`).join(", ")}` })
```

**优点**：
- 支持条件分支、循环、多步逻辑——一轮 LLM 调用可做多件事
- `await` 控制流，比串行 tool_call 更灵活
- 可通过 `prevRun.returnRaw` 实现跨轮数据传递

**缺点**：
- 需要大量 prompt engineering 教 LLM 写正确的 JS
- 错误处理复杂（sandbox + error burst guard + giveUp 机制）
- 对小模型不友好

**对 MineClaw 的参考**：MineClaw 计划让 LLM 写 Tool 函数（进化模式），AIRI 的 JS REPL 模式可以作为执行引擎的参考。但 MineClaw 的行为树 tick 执行更适合长时间自主任务。

### 3.2 Query DSL（链式只读查询）

AIRI 实现了一套优雅的 **链式查询 DSL**，用于感知环境：

```javascript
// 查附近矿石
const ores = query.blocks().within(24).isOre().names().uniq().list()

// 查背包
const hasPickaxe = query.inventory().has("stone_pickaxe", 1)

// 查附近实体
const players = query.entities().whereType("player").within(32).list()

// ASCII 地图
const area = query.map({ radius: 16 }); area.map

// 玩家视线
const gaze = query.gaze().find(g => g.playerName === "Alex")
```

特点：
- **只读**，无副作用——与 Action 严格分离
- **惰性链式**：`.within(24).isOre().sortByDistance().first()`
- **同步执行**：不需要 await，不走 LLM
- `query.map()` 可生成 ASCII 地图，给 LLM 空间感知

**对 MineClaw 的参考**：这个模式值得借鉴。MineClaw 的 Query Tool 可以设计为类似的链式 DSL，而不是每个查询一个独立的 Tool。这样 LLM 可以在一次调用中组合多个查询条件。

### 3.3 反射层（Reflex）

AIRI 的反射层独立于 LLM，处理不需要"思考"的即时反应：

```typescript
interface ReflexBehavior {
  id: string
  modes: ('idle' | 'work' | 'wander' | 'alert' | 'social')[]
  cooldownMs: number
  when: (ctx: ReflexContext, api: ReflexAPI) => boolean  // 触发条件
  score: (ctx: ReflexContext, api: ReflexAPI) => number  // 优先级评分
  run: (api: ReflexAPI) => Promise<void>                 // 执行
}
```

示例——`idle-gaze`：Bot 空闲时偶尔看向附近移动的玩家
- 只在 idle/social 模式下触发
- 概率跳过（30%）避免机器人感
- 平滑转头 + 防抖 + 死区过滤
- 有冷却时间

**对 MineClaw 的参考**：MineClaw 的执行脑可以借鉴这个反射层，将不需要 LLM 的即时反应（如自动吃食物、看向说话的人、跟随模式）抽离出来，由 Script 代码直接处理，减少 LLM 调用开销。

### 3.4 上下文边界管理

AIRI 的 Brain 有显式的任务边界：

```javascript
enterContext('collect stone for player')  // 开始任务
// ... 多轮执行 ...
exitContext('Collected 4 stone for Alex.')  // 归档任务，压缩历史
```

- `exitContext` 将当前任务的所有消息压缩为一行摘要
- 活跃上下文超过 30 条消息自动裁剪
- 归档摘要超过 10 条时折叠
- 支持任务中断：`exitContext('interrupted') → enterContext('new task')`

**对 MineClaw 的参考**：MineClaw 的规划脑在执行多步任务时需要类似的上下文管理。可以在 Skill 执行开始时 `enterContext`，结束时 `exitContext` 并写入 Skill 的历史记录。

### 3.5 Action 定义模式

```typescript
interface Action {
  name: string
  description: string
  schema: z.ZodObject<any>     // Zod 参数校验
  readonly?: boolean            // 是否只读
  followControl?: 'pause' | 'detach'  // 对跟随模式的影响
  execution?: 'sync' | 'async'       // 同步/异步
  perform: (mineflayer: Mineflayer) => (...args: any[]) => ActionResult
}
```

`perform` 是一个工厂函数——接收 Mineflayer 实例，返回实际执行函数。这样 Action 定义时不需要 bot 实例，运行时才绑定。

**对 MineClaw 的参考**：MineClaw 的 Tool/Primitive 定义可以参考这个模式：
- Zod schema 做参数校验（比手写 input_schema JSON 更安全）
- `perform` 工厂模式实现延迟绑定
- `followControl` 标记对其他系统的副作用

### 3.6 动作队列与错误保护

- **动作队列**：容量 1 执行 + 4 待处理，异步动作排队执行
- **Error Burst Guard**：连续错误超阈值时强制 `giveUp`，避免无限重试
- **No-action Budget**：限制连续"只观察不行动"的轮次（默认 3，最大 8）
- **反馈**：异步动作完成/失败后通过 EventBus 反馈给 Brain

---

## 四、目录结构

```
services/minecraft/src/
├── main.ts                           # 入口：Mineflayer + CognitiveEngine
├── composables/
│   ├── bot.ts                        # initBot 单例
│   └── config.ts                     # 环境变量
├── libs/mineflayer/
│   ├── core.ts                       # Mineflayer 类（连接/重连/插件加载）
│   ├── action.ts                     # Action 接口定义
│   ├── memory.ts                     # 简单 Memory
│   └── plugin.ts                     # wrapPlugin 适配器
├── cognitive/                        # 认知引擎
│   ├── index.ts                      # CognitiveEngine 插件入口
│   ├── container.ts                  # Awilix DI 容器
│   ├── event-bus.ts                  # EventBus（通配符订阅 + trace）
│   ├── perception/
│   │   ├── pipeline.ts               # 感知管线
│   │   ├── rules/system-message.yaml # YAML 感知规则
│   │   └── gaze.ts                   # 玩家视线计算
│   ├── reflex/
│   │   ├── reflex-manager.ts         # 信号 → 反射行为
│   │   ├── runtime.ts                # 模式 + 行为选择 + tick
│   │   └── behaviors/idle-gaze.ts    # 空闲注视行为
│   ├── conscious/
│   │   ├── brain.ts                  # Brain 主逻辑（队列/LLM/上下文）
│   │   ├── js-planner.ts            # JavaScript REPL 执行器
│   │   ├── query-dsl.ts             # 链式查询 DSL
│   │   ├── map-renderer.ts          # ASCII 地图渲染
│   │   ├── context-summary.ts       # 上下文摘要
│   │   └── prompts/brain-prompt.md  # System prompt 模板
│   └── action/
│       ├── llm-actions.ts           # 所有 Action 定义（25 个）
│       ├── action-registry.ts       # Action 注册中心
│       └── task-executor.ts         # 异步动作队列执行
├── skills/                          # 原子技能（被 Action 调用）
│   ├── movement.ts                  # goToPosition, goToPlayer, followPlayer
│   ├── blocks.ts                    # collectBlock, breakBlock
│   ├── crafting.ts                  # craftRecipe, smeltItem
│   ├── combat.ts                    # attackNearest, attackEntity
│   ├── inventory.ts                 # equip, discard, putInChest
│   └── world.ts                     # getNearbyBlocks, getNearbyEntities
└── debug/
    ├── index.ts                     # Debug HTTP/WS 服务
    ├── mcp-repl-server.ts           # MCP REPL 调试
    └── mineflayer-viewer.ts         # prismarine-viewer 集成
```

---

## 五、Action 清单

AIRI 共定义 25 个 Action，对标 MineClaw 的 Tool 层：

| Action | 类型 | 说明 |
|--------|------|------|
| `chat` | sync | 发送聊天消息 |
| `skip` | sync | 跳过本轮 |
| `giveUp` | sync | 承认卡住，暂停 |
| `stop` | async | 停止所有动作 |
| `goToPlayer` | async | A* 寻路到玩家 |
| `goToCoordinate` | async | A* 寻路到坐标（自动挖掘障碍） |
| `followPlayer` | sync | 设置空闲跟随 |
| `clearFollowTarget` | sync | 取消跟随 |
| `givePlayer` | async | 给玩家物品 |
| `consume` | async | 吃/喝 |
| `equip` | async | 装备物品 |
| `putInChest` | async | 存入箱子 |
| `takeFromChest` | async | 从箱子取 |
| `discard` | async | 丢弃物品 |
| `collectBlocks` | async | 采集指定类型方块 |
| `mineBlockAt` | async | 挖掘指定坐标方块 |
| `craftRecipe` | async | 合成（自动找/放工作台） |
| `smeltItem` | async | 冶炼 |
| `clearFurnace` | async | 清空熔炉 |
| `placeHere` | async | 放置方块 |
| `attack` | async | 攻击最近实体 |
| `attackPlayer` | async | 攻击指定玩家 |
| `goToBed` | async | 睡觉 |
| `activate` | async | 激活最近目标方块 |
| `recipePlan` | sync | 查询合成计划（只读） |

注意：AIRI 的 Action 基本等同于 MineClaw 的 **Tool 层**（组合型原子操作），
而非 Primitive 层。例如 `collectBlocks` 内部包含 find → pathfind → dig → collect 的完整流程。

---

## 六、感知系统

### 实时感知（Reflex tick）

ReflexRuntime 每 tick 从 bot 轮询并更新 ReflexContext：

| 类别 | 字段 | 来源 |
|------|------|------|
| self | position, heldItem, health, food | bot.entity |
| environment | timeOfDay, isRaining, nearbyPlayers, nearbyEntities, lightLevel | bot 属性 |
| social | lastSpeaker, lastMessage, socialGesture | 事件累积 |
| threat | threatScore | 规则引擎评估 |
| autonomy | followTarget | reflex 状态 |

### 信号感知（RuleEngine）

YAML 规则定义事件累积和信号阈值：

```yaml
# 示例：system-message.yaml
- signal: system_message
  from: raw:heard:system_message
  ...
```

### 查询感知（Query DSL）

LLM 通过 JS 代码主动查询，支持 7 种查询入口：
- `query.self()` — 自身状态快照
- `query.snapshot(range?)` — 世界快照
- `query.blocks()` — 链式方块查询
- `query.entities()` — 链式实体查询
- `query.inventory()` — 链式背包查询
- `query.craftable()` — 可合成物品
- `query.map()` — ASCII 地图（俯视/截面）
- `query.gaze()` — 玩家视线方向

---

## 七、对 MineClaw 的启发与借鉴

### 值得借鉴

| 模式 | 说明 | MineClaw 应用场景 |
|------|------|-----------------|
| **反射层分离** | 低层即时反应不走 LLM | 执行脑可拆出 Reflex 子系统处理自动吃食物、注视、跟随 |
| **Query DSL 链式查询** | 优雅的只读环境查询 | Query Tool 可设计为链式 DSL 而非多个独立 Tool |
| **上下文边界管理** | enterContext/exitContext + 摘要归档 | Skill 执行时自动管理上下文边界和历史 |
| **Error Burst Guard** | 连续错误保护 | 反思脑可实现类似机制：连续失败 → 降级/暂停/报告 |
| **No-action Budget** | 防止"只看不做"死循环 | 执行脑可设置行动预算 |
| **Zod Schema Action** | 类型安全的参数校验 | Tool 定义用 Zod 替代手写 JSON schema |
| **perform 工厂模式** | Action 定义与 bot 实例解耦 | Tool 的 perform 函数延迟绑定 Mineflayer 实例 |
| **动作队列** | 异步动作排队+取消+反馈 | 执行脑管理行为树异步 action 节点 |
| **ASCII 地图** | 给 LLM 空间感知能力 | slot:surroundings 可渲染 ASCII 地图注入上下文 |
| **followControl 标记** | 动作对其他系统的副作用声明 | Tool 可声明对反射层/感知层的副作用 |

### 与 MineClaw 的差异点

| 维度 | AIRI | MineClaw 计划 |
|------|------|-------------|
| LLM 交互方式 | JS REPL 输出 | Tool Calling + 行为树 |
| 行为策略 | LLM 每轮即时编程 | Skill 文件（行为树+HTN+历史） |
| 多步规划 | LLM 逐轮推进，无显式规划 | HTN+GOAP 规划脑 |
| 技能进化 | 无显式进化机制 | Skill/Tool 可被反思脑进化 |
| 脑系统 | 单一 Brain | 六脑分工 |
| 原语层次 | 扁平 Action 列表 | Primitive→Tool→Skill 三层 |
| 记忆 | 对话历史+上下文摘要 | 计划支持更丰富的 Skill 历史 |
| 行为树 | 无 | 嵌在 Skill 内，逐 tick 执行 |

### AIRI 的局限性（MineClaw 要避免）

1. **无长期技能积累**：AIRI 没有 Skill 文件，每次都要 LLM 从头编程。MineClaw 的 Skill 进化模式解决了这个问题。
2. **单脑瓶颈**：所有决策都经过一个 Brain，复杂任务时 LLM 负担重。MineClaw 的六脑分工可以更好地分配负载。
3. **无离线规划**：AIRI 没有 HTN/GOAP，无法预先分解复杂任务。MineClaw 的规划脑可以用算法而非 LLM 做任务分解。
4. **JS REPL 依赖强模型**：需要 GPT-4 级别的模型才能稳定输出正确 JS 代码。MineClaw 的 Tool Calling 模式对模型要求更低。

---

## 八、关键文件索引

| 功能 | 路径 |
|------|------|
| 入口 | `services/minecraft/src/main.ts` |
| Mineflayer 封装 | `services/minecraft/src/libs/mineflayer/core.ts` |
| 认知引擎入口 | `services/minecraft/src/cognitive/index.ts` |
| DI 容器 | `services/minecraft/src/cognitive/container.ts` |
| EventBus | `services/minecraft/src/cognitive/event-bus.ts` |
| Brain 主逻辑 | `services/minecraft/src/cognitive/conscious/brain.ts` |
| JS REPL 执行器 | `services/minecraft/src/cognitive/conscious/js-planner.ts` |
| Query DSL | `services/minecraft/src/cognitive/conscious/query-dsl.ts` |
| System Prompt | `services/minecraft/src/cognitive/conscious/prompts/brain-prompt.md` |
| Action 定义 | `services/minecraft/src/cognitive/action/llm-actions.ts` |
| Action 注册 | `services/minecraft/src/cognitive/action/action-registry.ts` |
| 任务执行器 | `services/minecraft/src/cognitive/action/task-executor.ts` |
| 反射管理 | `services/minecraft/src/cognitive/reflex/reflex-manager.ts` |
| 反射运行时 | `services/minecraft/src/cognitive/reflex/runtime.ts` |
| 空闲注视行为 | `services/minecraft/src/cognitive/reflex/behaviors/idle-gaze.ts` |
| 感知管线 | `services/minecraft/src/cognitive/perception/pipeline.ts` |
| 技能模块 | `services/minecraft/src/skills/` |
