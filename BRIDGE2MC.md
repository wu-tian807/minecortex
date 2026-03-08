# Bridge to Minecraft — MineCortex 接入我的世界路径

> 2025-03-05 调研决策记录 + 未来路线图

---

## 一、调研结论：从 Mod 到 Mineflayer 的转型

### 背景

MineCortex 最初通过自研 NeoForge Mod（MineAvatar）接入 Minecraft：
- AgentEntity 继承 PathfinderMob，是一个自定义怪物实体
- MineCortex 通过 TCP/JSON-RPC 向 Mod 发指令
- Mod 在 ActionRegistry 中注册原子行为供 RPC 调用

### 问题

这条路线有一个根本性缺陷：**Agent 不是玩家**。

PathfinderMob 没有背包、不能合成、不能打开容器、不能挖方块（没有挖掘进度系统）——
这些能力全部绑定在 ServerPlayer 上。每新增一个行为都要在 Java 侧手写实现，
而 Minecraft 的玩家交互系统极其庞大（41 个独立子系统），逐个实现不现实。

### 调研路径

1. 研究了 **Voyager**（MineDojo）和 **MindCraft**（kolbytn）两个开源 MC Agent 框架
2. 发现它们都基于 **Mineflayer**——一个用 JS 实现的完整 Minecraft 客户端
3. Mineflayer 通过 MC 协议（TCP 二进制包）连接服务器，服务器无法区分它和真人
4. 41 个插件覆盖了所有玩家交互：挖矿、放置、合成、箱子、熔炉、附魔、交易……
5. 也考察了 FakePlayer 方案（SiliconeDolls Mod），虽然解决了"Agent 是玩家"的问题，
   但仍需手写 GUI 交互、合成、寻路等大量代码

### 决策

**放弃 MineAvatar Mod 路线，转向 Mineflayer。**

理由：
- Mineflayer 41 个插件全部现成，零开发成本覆盖所有玩家操作
- 与 MineCortex 同为 TS/JS 生态，可在**同一进程**中运行，无需 TCP 桥接
- 行为树可通过 `bot.on('physicsTick')` 在每个游戏 tick 执行，与 Mod 方案无本质差异
- Prismarine 社区生态丰富（协议层、数据层、世界渲染、寻路……）
- 版本兼容由社区维护，无需每次 MC 更新手动适配

### 保留的 Mod 需求

唯一可能需要 Mod 的场景：**MmdSkin 配置控制**。

Mineflayer Bot 连入后是真正的 Player，MmdSkin 客户端 Mod 天然支持给它换 MMD 模型。
但"选择哪个模型"可能需要一个轻量服务端 Mod 来存储映射关系，或通过自定义协议包通知客户端。
这个 Mod 只做 MMD 配置，不含任何 Agent 逻辑。

---

## 二、Mineflayer 的技术原理

### 它为什么能用 JS 控制 Java 版 Minecraft

Minecraft 的网络协议是公开的、语言无关的。官方 Java 客户端和 Mineflayer
走的是完全相同的 TCP 协议——服务器无法区分它们。

```
MC 服务器 ──TCP协议包──→ Java 客户端（渲染 3D 画面）
MC 服务器 ──TCP协议包──→ Mineflayer（存到 JS 对象，不渲染）
```

服务器发送**结构化数据包**（方块数据、实体位置、背包内容、血量……），
不是像素。Mineflayer 接收这些包后维护完整的游戏状态，
再通过发送对应的包来执行动作（发送 block_dig 包 = 玩家按住左键挖方块）。

### 协议栈

```
node-minecraft-protocol（TCP 连接 + 登录 + 加密 + 压缩 + 包序列化）
       ↓
mineflayer（高层 Bot API：bot.dig(), bot.craft(), bot.attack() ...）
       ↓
mineflayer-pathfinder / mineflayer-pvp / mineflayer-collectblock / ...（插件）
       ↓
minecraft-data（所有 MC 版本的方块/物品/实体/配方数据）
```

### 额外能力：世界可视化

服务器发给客户端的区块数据（map_chunk 包）包含完整的方块信息。
prismarine-viewer 项目可以用 Three.js 在浏览器中实时渲染 Bot 看到的 3D 世界，
仅需一行代码集成，可用于调试和可视化。

---

## 三、新架构设计

### 总览

```
┌──────────────────────────────────────────────────────────────┐
│  MineCortex 进程（TypeScript，单进程）                          │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ 六脑系统                                                │ │
│  │  意识脑 ← LLM 高层决策，目标设定                         │ │
│  │  规划脑 ← HTN + GOAP，任务分解                           │ │
│  │  执行脑 ← 行为树 tick 执行，驱动 Mineflayer              │ │
│  │  感知脑 ← 世界状态采集，事件过滤                         │ │
│  │  反思脑 ← 执行评估，技能进化                             │ │
│  │  社交脑 ← 多 Agent 通信，玩家交互                        │ │
│  └──────────────────────┬──────────────────────────────────┘ │
│                         │                                    │
│  ┌──────────────────────┴──────────────────────────────────┐ │
│  │ Mineflayer Bot                                          │ │
│  │  bot.on('physicsTick') → 执行脑行为树 tick               │ │
│  │  41 个插件（挖/放/合成/箱子/寻路/PvP/……）               │ │
│  │  完整的游戏状态（entities, blocks, inventory, ……）       │ │
│  └──────────────────────┬──────────────────────────────────┘ │
│                         │ Minecraft Protocol (TCP)           │
└─────────────────────────┼────────────────────────────────────┘
                          ▼
                ┌──────────────────┐
                │ MC Java 服务器    │
                │ + MmdSkin Mod    │
                │   (可选，仅换肤)  │
                └──────────────────┘
```

### 与旧架构的对比

| 维度 | 旧（MineAvatar Mod） | 新（Mineflayer） |
|------|---------------------|-----------------|
| Agent 身份 | PathfinderMob（怪物） | 真正的 Player |
| 通信方式 | TCP/JSON-RPC 跨进程 | 同进程直接调用 |
| 可用行为 | ActionRegistry 注册了多少就有多少 | 41 个插件，全部现成 |
| 行为树 tick | Mod 侧 Java tick | `bot.on('physicsTick')` TS tick |
| 感知数据 | Mod 需主动暴露 | 协议包全部自动解析 |
| 新行为成本 | 写 Java → 编译 Mod → 重启 | 写 Tool（TS 函数）或 Skill（Markdown）→ 热加载 |
| 版本适配 | 每次 MC 更新手动改 | 社区维护协议兼容 |
| MMD 模型 | Mod 内部控制 | MmdSkin Mod 天然支持 Player 换肤 |

---

## 四、实施路径

### Phase 0：验证 Mineflayer 基础（立即）

**目标**：在 MineCortex 中跑通 Mineflayer，验证 Bot 连接、基础行为、physicsTick。

- [ ] 安装 mineflayer 及核心插件到 MineCortex
  ```
  pnpm add mineflayer mineflayer-pathfinder mineflayer-pvp
  pnpm add mineflayer-collectblock mineflayer-auto-eat
  pnpm add minecraft-data prismarine-viewer vec3
  ```
- [ ] 编写 `src/mc/bot.ts`——Bot 连接与生命周期管理
  - `createBot({ host, port, username })`
  - 事件绑定：spawn, death, health, physicsTick
  - 与 MineCortex EventBus 对接（MC 事件 → MineCortex Event）
- [ ] 编写 `src/mc/perception.ts`——感知层，分三种模式接入 MineCortex 体系：
  - Slot 同步：`setInterval` 定期采集 position/health/inventory → 注入 `slot:self`、`slot:inventory`
  - Subscription 事件：`bot.on('health'|'chat'|'death'|...)` → EventBus → message Slot
  - Query Tool：按需搜索 `mc.nearbyBlocks`、`mc.recipes` 等
- [ ] 验证场景：连接本地 MC 服务器，Bot 能移动、挖方块、放方块、打开箱子

### Phase 1：三层原语体系（核心）

**目标**：建立 Primitive → Tool → Skill 三层体系，将 Mineflayer 的能力逐层封装。

参考 Voyager 的 6 个原语 + MindCraft 的 40+ 命令，设计三层结构：

#### Primitive 层——Mineflayer API 直接映射（不可变）

Primitive 是最底层的原子操作，1:1 映射 Mineflayer API。
框架预制，不可修改，不可新建——它们就是"指令集"。

| Primitive | Mineflayer API | 说明 |
|-----------|---------------|------|
| `prim.moveTo` | pathfinder.goto() | 寻路移动到坐标 |
| `prim.dig` | bot.dig(block) | 挖掘指定方块 |
| `prim.place` | bot.placeBlock() | 放置方块 |
| `prim.attack` | bot.attack(entity) | 攻击实体 |
| `prim.useItem` | bot.activateItem() | 使用手持物品 |
| `prim.useBlock` | bot.activateBlock() | 右键点击方块 |
| `prim.craft` | bot.craft(recipe) | 合成物品 |
| `prim.smelt` | bot.openFurnace() → furnace.putFuel/Input | 冶炼 |
| `prim.equip` | bot.equip(item, destination) | 装备物品 |
| `prim.toss` | bot.tossStack(item) | 丢弃物品 |
| `prim.eat` | bot.consume() | 吃/喝 |
| `prim.lookAt` | bot.lookAt(pos) | 看向位置 |
| `prim.chat` | bot.chat(msg) | 发送聊天消息 |
| `prim.openContainer` | bot.openContainer(block) | 打开箱子/容器 |
| `prim.transfer` | window.deposit/withdraw | 容器内物品转移 |
| `prim.sleep` | bot.sleep(bed) | 睡觉 |

#### Tool 层——原子函数（可组合、可新建）

Tool 是由 Primitive 组合而成的原子函数。语义上仍是"做一件事"——
调用即执行，确定性返回，没有策略决策，没有历史记录。

预制 Tool 和 LLM 生成的 Tool 没有任何区别——都是 `tools/` 下的 TS 函数文件。
同一组 Primitive，不同的执行方式和参数顺序，就构成不同的 Tool。

| Tool | 组合的 Primitive | 说明 |
|------|-----------------|------|
| `mc.mineBlock` | findBlock → prim.moveTo → prim.dig → collect | 搜索+前往+挖掘+拾取 |
| `mc.stripMine` | prim.dig forward → step → repeat | 条带挖矿模式 |
| `mc.veinMine` | prim.dig → scan adjacent → recursive dig | 矿脉挖矿模式 |
| `mc.craftItem` | 检查材料 → 找工作台 → prim.moveTo → prim.craft | 完整合成流程 |
| `mc.smeltItem` | 找熔炉 → prim.moveTo → prim.smelt | 完整冶炼流程 |
| `mc.placeItem` | 找放置面 → prim.moveTo → prim.equip → prim.place | 完整放置流程 |
| `mc.buildColumn` | loop: prim.place → jump | 向上搭柱子 |
| `mc.bridgeAcross` | loop: sneak → prim.place → step back | 搭桥 |
| `mc.killMob` | findEntity → prim.moveTo → pvp.attack → collect | 完整击杀流程 |
| `mc.explore` | 随机方向移动 → 定时检查条件 | 探索直到发现目标 |
| `mc.goToPlayer` | 找玩家 → prim.moveTo | 前往玩家位置 |
| `mc.storeItems` | 找箱子 → prim.moveTo → prim.openContainer → prim.transfer | 物品存储 |
| `mc.clearArea` | scan area → batch prim.dig | 清空一片区域 |

#### 感知体系——Slot / Subscription / Query 三种模式

不是所有感知都该手动查询。感知数据按获取模式分为三类，
对应 MineCortex 已有的 Slot（P7）和 Subscription（P8）体系：

**1. Slot（定时同步，注入 system prompt）**

通过 `setInterval` 定期采集，自动同步到 ContextSlot，LLM 每次对话都能看到。
不需要调用 Tool，数据始终存在于上下文中。

| Slot | 数据来源 | 更新频率 | 说明 |
|------|---------|---------|------|
| `slot:self` | bot.entity | ~1s | 位置、血量、饱食度、等级、维度、游戏时间 |
| `slot:inventory` | bot.inventory | ~2s | 背包 36 格 + 快捷栏内容 |
| `slot:equipment` | bot.heldItem / bot.entity.equipment | ~2s | 当前手持物品 + 穿戴装备 |
| `slot:surroundings` | bot.blockAt() 采样 | ~3s | 脚下/头顶/前方方块类型，所处生态群系 |

**2. Subscription（事件驱动，注入 message）**

通过 Mineflayer 事件 → MineCortex EventBus → Event Router → message Slot。
事件发生时立即推送，成为 LLM 下一轮对话的 user message 的一部分。

| Subscription | Mineflayer 事件 | 说明 |
|-------------|----------------|------|
| `sub:health` | bot.on('health') | 血量/饱食度变化（含受伤原因） |
| `sub:death` | bot.on('death') | 死亡事件 + 死亡原因 |
| `sub:chat` | bot.on('chat') | 收到聊天消息（玩家/系统） |
| `sub:entityAppear` | bot.on('entitySpawned') | 新实体出现在视野内（玩家/怪物） |
| `sub:entityGone` | bot.on('entityGone') | 实体离开视野或死亡 |
| `sub:blockUpdate` | bot.on('blockUpdate') | 附近方块变化（被挖/被放） |
| `sub:rain` | bot.on('rain') | 天气变化 |
| `sub:goalCompleted` | 执行脑 emit | 行为树子目标完成 |
| `sub:goalFailed` | 执行脑 emit | 行为树子目标失败（含失败原因） |

**3. Query Tool（按需查询，LLM 主动调用）**

只有需要参数化搜索、数据量大、或不需要实时的感知才做成 Tool。

| Tool | 数据来源 | 说明 |
|------|---------|------|
| `mc.nearbyBlocks` | bot.findBlocks() | 搜索指定类型的附近方块（需要 blockType + maxDistance 参数） |
| `mc.nearbyEntities` | bot.entities 过滤 | 按类型/距离搜索附近实体 |
| `mc.recipes` | bot.recipesFor() | 查询指定物品的可用合成配方 |
| `mc.blockAt` | bot.blockAt(pos) | 查询指定坐标的方块信息 |
| `mc.findPlayer` | bot.players | 查找指定玩家的位置和状态 |

#### 目录结构

```
tools/
├── primitives/         ← 不可变，框架预制，1:1 映射 Mineflayer API
│   ├── dig.ts
│   ├── place.ts
│   ├── moveTo.ts
│   ├── craft.ts
│   ├── attack.ts
│   └── ...
├── composed/           ← 预制的组合 Tool
│   ├── mineBlock.ts
│   ├── craftItem.ts
│   ├── buildColumn.ts
│   ├── killMob.ts
│   └── ...
├── generated/          ← LLM 生成的新 Tool
│   ├── stripMine.ts
│   ├── veinMine.ts
│   ├── bridgeAcross.ts
│   └── ...
└── query/              ← 查询类 Tool（只读感知）
    ├── status.ts
    ├── inventory.ts
    └── ...
```

### Phase 2：Tool 进化——LLM 写新的原子函数（关键创新）

**目标**：允许 LLM 在运行时编写新的 Tool（原子函数），扩充 `tools/generated/` 目录。

这是 MineCortex 与 MindCraft 的核心差异——MindCraft 用固定的 40 个命令，
而我们让 LLM 像 Voyager 一样"写代码"，但写的不是裸 JS，而是 MineCortex Tool 函数。

**关键约束：Tool 是函数，不是策略。**
LLM 写的 Tool 必须是确定性的原子操作——调用即执行，无条件分支、无 fallback、无历史记录。
策略性的东西（行为树、前提条件、成本估算、历史记录）属于 Skill 层（Phase 3）。

**Tool 进化示例**：

```typescript
// tools/generated/stripMine.ts
// LLM 生成的新 Tool：条带挖矿
// 语义上是"一个原子动作"——在 y 层挖一条 1x2 隧道
export async function stripMine(bot, y: number, length: number = 20) {
  await prim.moveTo(bot, { y, mode: "descend" })
  for (let i = 0; i < length; i++) {
    const front = bot.blockAt(bot.entity.position.offset(/* forward */))
    if (front) await prim.dig(bot, front)
    const above = bot.blockAt(bot.entity.position.offset(0, 1, 0))
    if (above) await prim.dig(bot, above)
    // step forward
  }
  return { mined: length * 2 }
}
```

**进化流程**：

```
1. 意识脑设定目标："用条带挖矿法挖钻石"
2. 规划脑分解子任务，发现没有 "stripMine" Tool
3. 反思脑触发 Tool 进化：让 LLM 基于 Primitive 编写新的原子函数
4. LLM 生成 tools/generated/stripMine.ts
   - 内部组合 prim.moveTo + prim.dig，确定性执行
5. ToolLoader 热加载新 Tool
6. 新 Tool 可被 Skill 的行为树引用，也可被 LLM 直接调用
7. 下次遇到类似场景 → 直接复用已有 Tool
```

**与 Voyager 的区别**：
- Voyager 写裸 JS 函数，通过 eval() 执行——不安全，不可控
- MineCortex 写 ToolDefinition 文件——有 schema 约束，有权限控制，可热加载，可版本管理
- Tool 自动获得 LLM 可见的 description + input_schema，无需额外标注
- Tool 只负责"做一件事"，策略性编排由上层 Skill 负责

### Phase 3：六脑原型实现

**目标**：实现 6 个专业化脑，形成完整的 Agent 决策链路。

#### 脑的分工

| 脑 | 类型 | 职责 | 订阅 |
|----|------|------|------|
| **意识脑 (Conscious)** | LLM | 高层目标设定、价值判断、自由意志 | heartbeat(慢), bus |
| **规划脑 (Planner)** | Script | HTN 任务分解 + GOAP 目标搜索 | bus(来自意识脑的目标) |
| **执行脑 (Executor)** | Script | 行为树 tick 执行、驱动 Mineflayer | physicsTick, bus(来自规划脑的计划) |
| **感知脑 (Perceiver)** | Script | 世界状态过滤、异常检测、事件生成 | physicsTick(快), 游戏事件 |
| **反思脑 (Reflector)** | LLM | 执行评估、Skill 进化（改行为树）、Tool 进化（写新函数）、经验总结 | bus(执行结果), heartbeat(慢) |
| **社交脑 (Social)** | LLM | 玩家对话、多 Agent 协调 | stdin, chat 事件 |

#### 决策链路

```
玩家说"帮我建个房子"
        ↓
   社交脑（理解意图）
        ↓ emit: goal("build_house")
   意识脑（评估目标合理性，设定优先级）
        ↓ emit: approved_goal("build_house", priority=high)
   规划脑（HTN 分解）
        ↓ emit: plan([
        │   "collect 20 oak_log",
        │   "craft 80 oak_planks",
        │   "find flat area",
        │   "build walls",
        │   "build roof"
        │ ])
   执行脑（行为树执行每个子任务，action 节点调用 Tool → Primitive → Mineflayer）
        ↓ 通过 Tool/Primitive 驱动 Mineflayer 实际操作游戏
   感知脑（监控执行状态，检测异常）
        ↓ emit: anomaly("inventory_full") 或 status("subtask_complete")
   反思脑（评估结果）
        ↓ emit: skill_learned("build_house", success_rate=0.8)
        ↓ 或 emit: replan_needed("材料不够")
```

### Phase 4：LLM → HTN+GOAP → 行为树 决策框架

**目标**：构建三层决策架构，让每一层都对 LLM 可感知。

#### 三层决策架构（与 Primitive/Tool/Skill 三层原语架构正交）

```
┌──────────────────────────────────────┐
│ Layer 1: LLM 意识层（慢思考）         │
│                                      │
│ "我要在河边建一座木屋"                │
│ → 高层目标 + 价值判断 + 创意决策      │
│ → 输出: Goal { type, priority, ctx } │
└────────────────┬─────────────────────┘
                 ↓
┌──────────────────────────────────────┐
│ Layer 2: HTN+GOAP 规划层（算法）      │
│                                      │
│ HTN: 任务网络分解                     │
│   build_house → [collect, craft,     │
│                   find_site, build]  │
│                                      │
│ GOAP: 目标导向搜索                    │
│   目标: has(oak_planks, 80)           │
│   前提: has(oak_log, 20)              │
│   动作: craft(oak_log→oak_planks)     │
│                                      │
│ → 输出: Plan [TaskNode...]           │
└────────────────┬─────────────────────┘
                 ↓
┌──────────────────────────────────────┐
│ Layer 3: 行为树执行层（每 tick）       │
│                                      │
│ Root                                 │
│ └─ Sequence                          │
│    ├─ Condition: has_tool("axe")     │
│    ├─ Action: mc.mineBlock("oak_log")│
│    ├─ Condition: inventory_count     │
│    │             ("oak_log") >= 20   │
│    └─ Action: report_complete()      │
│                                      │
│ → 输出: Tool 调用 → Primitive → 协议包│
└──────────────────────────────────────┘
```

#### Primitive / Tool / Skill 三层原语架构

```
┌──────────────────────────────────────────────────────────┐
│ Skill 层（策略包 —— 可进化，用于自动化和反思）             │
│                                                          │
│  skills/mine_diamonds.md   ← 行为树 + HTN + 成本 + 历史  │
│  skills/build_house.md     ← 可被 LLM 读/写/改           │
│  skills/combat_skeleton.md ← 反思脑更新成功率             │
│                                                          │
│  Skill = 行为树 + 前提条件 + HTN 分解 + 成本估算          │
│          + 历史记录 + LLM 可理解的描述                    │
│  行为树的叶子节点 = Tool 调用                             │
└──────────────────────┬───────────────────────────────────┘
                       │ 行为树的 action 节点调用 Tool
                       ▼
┌──────────────────────────────────────────────────────────┐
│ Tool 层（原子函数 —— 可组合、可新建，确定性执行）          │
│                                                          │
│  预制:  mc.mineBlock, mc.craftItem, mc.killMob ...       │
│  生成:  mc.stripMine, mc.veinMine, mc.bridgeAcross ...   │
│                                                          │
│  内部组合 Primitive，但语义上仍是"做一件事"               │
│  调用即执行，无策略决策，无历史记录                        │
│  LLM 可以编写新的 Tool 函数                              │
└──────────────────────┬───────────────────────────────────┘
                       │ Tool 内部调用 Primitive
                       ▼
┌──────────────────────────────────────────────────────────┐
│ Primitive 层（Mineflayer API 直接映射 —— 不可变）         │
│                                                          │
│  prim.dig, prim.place, prim.craft, prim.moveTo ...      │
│  1:1 映射 bot.dig(), bot.placeBlock(), bot.craft() ...  │
│  类比 CPU 指令集——硬件决定，不变                          │
└──────────────────────────────────────────────────────────┘
```

**三层各司其职：Primitive 不变，Tool 可新建，Skill 可进化。**

| 维度 | Primitive | Tool | Skill |
|------|-----------|------|-------|
| 本质 | API 映射 | 函数 | 策略包（Markdown 文件） |
| 执行方式 | 直接调用 Mineflayer | 调用即执行，await 返回 | 行为树逐 tick 驱动 |
| 确定性 | 完全确定 | 确定（无分支决策） | 有条件分支、fallback、重试 |
| 状态 | 无状态 | 无状态 | 有历史记录、成功率、改进备注 |
| 可变性 | 不可变 | 可组合新建（LLM 写函数） | 可进化（LLM 编辑行为树） |
| 存储 | `tools/primitives/*.ts` | `tools/composed/*.ts` + `tools/generated/*.ts` | `skills/*.md` |
| 谁调用 | 被 Tool 内部调用 | 被 Skill 行为树叶节点调用，或被 LLM 直接调用 | 被 Planner/Executor 脑选择执行 |
| 类比 | CPU 指令 | 标准库函数 / 用户定义函数 | 程序（含流程控制 + 状态） |

- Primitive 是最小粒度——`prim.dig` 就是 `bot.dig()`，一行代码
- Tool 组合 Primitive 成为有意义的原子操作——`mc.mineBlock` 内部串联 find → moveTo → dig → collect，但对外仍是"做一件事"
- Skill 编排 Tool 成为完整策略——行为树里有 condition、fallback、subtree 引用，有前提条件和成本估算
- 同一组 Primitive，不同的执行顺序 = 不同的 Tool（`mc.stripMine` vs `mc.veinMine` 都用 `prim.dig`）
- 行为树**嵌在 Skill 内部**——一个 Skill 文件就是"怎么做某件事"的完整知识

#### Skill 文件结构

```
skills/
├── mine_diamonds.md          ← 内含行为树+计划+成本+历史
├── build_house.md
├── combat_skeleton.md
├── farm_wheat.md
├── smelt_iron.md
└── explore_cave.md
```

每个 Skill 文件是**自包含的策略包**，LLM 可直接阅读和修改。

#### Skill 文件格式示例

`skills/mine_diamonds.md`：

````markdown
# mine_diamonds

## 描述
挖掘钻石矿并收集钻石。需要铁镐或更好的工具。

## 前提条件
- has_tool("iron_pickaxe") 或 has_tool("diamond_pickaxe")
- 无特定位置要求（会自动下到 y=11）

## HTN 分解
1. ensure_tool("iron_pickaxe") → 如果没有，先触发 craft_iron_pickaxe skill
2. descend_to_y(11) → 挖下去或找洞穴
3. branch_mine() → 分支矿道探索
4. mine_diamond_ore() → 发现钻石矿后挖掘
5. collect_drops() → 拾取掉落物

## 行为树
```json
{
  "type": "sequence",
  "children": [
    {
      "type": "fallback",
      "children": [
        { "type": "condition", "check": "has_item", "params": { "item": "iron_pickaxe" } },
        { "type": "subtree", "skill": "craft_iron_pickaxe" }
      ]
    },
    { "type": "action", "tool": "mc.equip", "params": { "item": "iron_pickaxe" } },
    { "type": "action", "tool": "mc.moveTo", "params": { "y": 11, "mode": "descend" } },
    {
      "type": "repeat",
      "times": -1,
      "child": {
        "type": "sequence",
        "children": [
          { "type": "action", "tool": "mc.explore", "params": { "target": "diamond_ore", "range": 32 } },
          { "type": "action", "tool": "mc.mineBlock", "params": { "block": "diamond_ore" } },
          {
            "type": "condition", "check": "inventory_count",
            "params": { "item": "diamond", "min": 5 },
            "on_success": "break"
          }
        ]
      }
    }
  ]
}
```

## 成本估算
- 时间: ~8 分钟
- 工具消耗: 1 把铁镐耐久
- 风险: 岩浆、怪物

## 历史记录
- 尝试 5 次，成功 4 次 (80%)
- 平均耗时: 7.2 分钟
- 失败原因: 遇到岩浆未检测(1次)

## 改进备注
> 第 3 次尝试后，反思脑在 fallback 节点前增加了岩浆检测 condition，
> 成功率从 60% 提升到 80%。
````

#### 进化机制

行为树的进化通过 LLM 读写 Skill 文件实现：

```
执行脑: tick 行为树，遇到"掉进岩浆"失败
    ↓
反思脑: 读取 skills/mine_diamonds.md，分析失败原因
    ↓
反思脑: edit_file → 在行为树的 explore 节点前插入：
    { "type": "condition", "check": "block_below_safe",
      "params": { "unsafe": ["lava", "water"] } }
    ↓
反思脑: 更新历史记录 + 成功率
    ↓
ToolLoader 热加载（或下次执行时重新读取 Skill 文件）
    ↓
下次执行 mine_diamonds 时自动使用改进后的行为树
```

**预制 Skill 也可以被进化**——框架不区分"预装"和"LLM 生成"的 Skill，
它们都是 skills/ 目录下的文件，都可以被读取、修改、新建。

行为树中的 `subtree` 节点可以引用其他 Skill（如 `craft_iron_pickaxe`），
形成 Skill 之间的组合与复用。

LLM 通过 `read_skill` 工具读取 Skill 来了解可用技能和历史表现，
通过 `write_file` / `edit_file` 工具来改进或创建 Skill——这就是"LLM 在工作区内自由发挥"。

### Phase 5：轻量 MMD Mod（按需）

**目标**：如果 MmdSkin 无法通过 Mineflayer 协议配置，写一个极轻量的服务端 Mod。

可能的方案：
- 方案 A：服务端 Mod 监听自定义频道，MineCortex 通过 Mineflayer 发送 plugin channel 消息
  来指定 Bot 使用的 MMD 模型。MmdSkin 客户端 Mod 读取此配置渲染模型。
- 方案 B：利用 MmdSkin 已有的配置机制（如果支持服务端配置文件指定玩家模型映射）。
- 方案 C：完全不做——让玩家在客户端手动给 Bot 换肤（MmdSkin 支持对任意 Player 换肤）。

优先级最低，等核心功能跑通后再处理。

---

## 五、参考仓库索引

所有参考仓库已克隆到 `mc-agent-reference/`：

| 仓库 | 路径 | 用途 |
|------|------|------|
| Voyager | `mc-agent-reference/Voyager/` | LLM 技能进化范式参考 |
| MindCraft | `mc-agent-reference/mindcraft/` | 原子行为覆盖度参考 |
| SiliconeDolls | `mc-agent-reference/SiliconeDolls/` | NeoForge FakePlayer 参考（备选方案） |
| mineflayer | `mc-agent-reference/mineflayer/` | 核心依赖，41 个插件源码 |
| node-minecraft-protocol | `mc-agent-reference/node-minecraft-protocol/` | 协议层参考 |
| minecraft-data | `mc-agent-reference/minecraft-data/` | MC 游戏数据（方块/物品/配方） |

详细调研报告见 `mc-agent-reference/RESEARCH-3-5.md`。

---

## 六、与 MineCortex roadmap 的关系

本文档是 `docs/roadmap.md` 的**领域扩展**——roadmap 定义了 MineCortex 框架本身的演进，
本文档定义了 MineCortex 如何接入 Minecraft 这个具体领域。

两者的交汇点：

| roadmap 能力 | 在 MC 场景的应用 |
|-------------|----------------|
| §0 fs-watcher | 监控 `tools/generated/` 和 `skills/` 目录，热加载 LLM 生成的新 Tool 和改进的 Skill |
| §4 ContextSlot | slot:world（MC 世界感知数据）、slot:plan（当前执行计划） |
| §5 Skills | MC Skill 文件（`skills/*.md`，内含行为树 + HTN + 成本 + 历史） |
| §6 ScriptBrain | 规划脑（HTN+GOAP）、执行脑（行为树 tick）、感知脑 |
| §8 工具补全 | Primitive 层（`tools/primitives/`）+ Tool 层（`tools/composed/`）（Phase 1） |
| evolve 模式 | Tool 进化（Phase 2：LLM 写 `tools/generated/`）+ Skill 进化（反思脑改行为树） |
