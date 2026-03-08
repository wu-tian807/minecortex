# Roadmap: Embody — MineCortex 接入 Minecraft 实施记录

> 基于 [BRIDGE2MC.md](../BRIDGE2MC.md) 的实施路径，跟踪每个阶段的完成状态。

---

## Phase 0：验证 Mineflayer 基础

**目标**：跑通 Mineflayer，验证 Bot 能连接 MC 服务器并正常交互。

- [x] 安装 mineflayer 及核心插件（独立验证环境 `mineflayer-dev/`）
- [x] Bot 连接 MC 1.21.1 服务器（WSL → Windows，`172.31.176.1:25565`）
- [x] 验证 spawn、位置、血量、游戏模式、维度等基础数据获取
- [x] 验证聊天收发（bot.chat + bot.on('chat')）
- [x] 验证在线玩家列表、附近实体、背包读取
- [ ] 集成到 MineCortex 项目（`src/mc/bot.ts`）
- [ ] 编写感知层（`src/mc/perception.ts`），接入 Slot/Subscription/Query 三种模式
- [ ] 验证 physicsTick 行为树 tick 可行性
- [ ] 验证进阶交互：移动、挖方块、放方块、打开箱子

**验证记录**（2025-03-05）：
```
连接地址: 172.31.176.1:25565 (WSL2 → Windows)
MC 版本: 1.21.1
用户名: MineCortex
位置: x=2.5, y=-60.0, z=6.5
游戏模式: creative → survival（由玩家切换）
在线玩家: wu_tian_
状态: 连接成功，Bot 正常出生，聊天收发正常
```

---

## Phase 1：三层原语体系

**目标**：建立 Primitive → Tool → Skill 三层体系。

### Primitive 层（不可变，映射 Mineflayer API）

- [ ] `prim.moveTo` — pathfinder.goto()
- [ ] `prim.dig` — bot.dig()
- [ ] `prim.place` — bot.placeBlock()
- [ ] `prim.attack` — bot.attack()
- [ ] `prim.useItem` — bot.activateItem()
- [ ] `prim.useBlock` — bot.activateBlock()
- [ ] `prim.craft` — bot.craft()
- [ ] `prim.smelt` — bot.openFurnace()
- [ ] `prim.equip` — bot.equip()
- [ ] `prim.toss` — bot.tossStack()
- [ ] `prim.eat` — bot.consume()
- [ ] `prim.lookAt` — bot.lookAt()
- [ ] `prim.chat` — bot.chat()
- [ ] `prim.openContainer` — bot.openContainer()
- [ ] `prim.transfer` — window.deposit/withdraw
- [ ] `prim.sleep` — bot.sleep()

### Tool 层（可组合，可新建）

- [ ] `mc.mineBlock` — 搜索+前往+挖掘+拾取
- [ ] `mc.craftItem` — 完整合成流程
- [ ] `mc.smeltItem` — 完整冶炼流程
- [ ] `mc.placeItem` — 完整放置流程
- [ ] `mc.killMob` — 完整击杀流程
- [ ] `mc.explore` — 探索直到发现目标
- [ ] `mc.goToPlayer` — 前往玩家位置
- [ ] `mc.storeItems` — 物品存储

### 感知体系

- [ ] `slot:self` — 位置/血量/饱食度（setInterval ~1s）
- [ ] `slot:inventory` — 背包内容（setInterval ~2s）
- [ ] `slot:equipment` — 装备状态（setInterval ~2s）
- [ ] `slot:surroundings` — 周围环境（setInterval ~3s）
- [ ] `sub:health` — 血量变化事件
- [ ] `sub:death` — 死亡事件
- [ ] `sub:chat` — 聊天消息事件
- [ ] `sub:entityAppear` — 实体出现事件
- [ ] `sub:entityGone` — 实体消失事件
- [ ] `sub:blockUpdate` — 方块变化事件
- [ ] `mc.nearbyBlocks` — 按需查询附近方块
- [ ] `mc.nearbyEntities` — 按需查询附近实体
- [ ] `mc.recipes` — 查询合成配方
- [ ] `mc.blockAt` — 查询指定坐标方块
- [ ] `mc.findPlayer` — 查找玩家

### 目录结构

- [ ] 创建 `tools/primitives/` 目录
- [ ] 创建 `tools/composed/` 目录
- [ ] 创建 `tools/generated/` 目录
- [ ] 创建 `tools/query/` 目录
- [ ] 实现 ToolLoader 加载机制

---

## Phase 2：Tool 进化 — LLM 写新的原子函数

**目标**：允许 LLM 运行时编写新 Tool，扩充 `tools/generated/`。

- [ ] Tool 函数模板与约束定义（schema + perform 工厂模式）
- [ ] ToolLoader 热加载 `tools/generated/*.ts`
- [ ] 反思脑触发 Tool 进化的事件流
- [ ] LLM 生成 Tool 的 prompt 模板
- [ ] Tool 验证与沙盒执行
- [ ] 生成的 Tool 自动注册 description + input_schema

---

## Phase 3：六脑原型实现

**目标**：实现 6 个专业化脑，形成完整的 Agent 决策链路。

- [ ] 意识脑 (Conscious) — LLM 高层决策
- [ ] 规划脑 (Planner) — HTN + GOAP 任务分解
- [ ] 执行脑 (Executor) — 行为树 tick 执行
- [ ] 感知脑 (Perceiver) — 世界状态过滤与事件生成
- [ ] 反思脑 (Reflector) — Skill/Tool 进化 + 经验总结
- [ ] 社交脑 (Social) — 玩家对话 + 多 Agent 协调
- [ ] 六脑间 EventBus 通信链路
- [ ] 决策链路：社交→意识→规划→执行→感知→反思

---

## Phase 4：决策框架 — LLM → HTN+GOAP → 行为树

**目标**：构建三层决策架构，每层对 LLM 可感知。

- [ ] HTN 任务网络分解引擎
- [ ] GOAP 目标导向搜索引擎
- [ ] 行为树运行时（Sequence/Fallback/Condition/Action/Repeat/Subtree）
- [ ] Skill 文件解析器（Markdown → 行为树 JSON）
- [ ] Skill 进化机制（反思脑 edit_file → 热加载）
- [ ] Skill 间 subtree 引用与组合
- [ ] `read_skill` 工具

---

## Phase 5：轻量 MMD Mod（按需）

**目标**：如需要，写极轻量服务端 Mod 控制 MmdSkin 配置。

- [ ] 评估 MmdSkin 是否支持通过 plugin channel 配置
- [ ] 方案选型（plugin channel / 配置文件 / 手动换肤）
- [ ] 实现（如果需要）

---

## 参考仓库

| 仓库 | 路径 | 用途 |
|------|------|------|
| Voyager | `mc-agent-reference/Voyager/` | LLM 技能进化范式 |
| MindCraft | `mc-agent-reference/mindcraft/` | 原子行为覆盖度 |
| AIRI | `mc-agent-reference/airi/` | 认知架构 + Query DSL + 反射层 |
| SiliconeDolls | `mc-agent-reference/SiliconeDolls/` | FakePlayer 参考（备选） |
| mineflayer | `mc-agent-reference/mineflayer/` | 核心依赖源码 |
| node-minecraft-protocol | `mc-agent-reference/node-minecraft-protocol/` | 协议层 |
| minecraft-data | `mc-agent-reference/minecraft-data/` | 游戏数据 |

调研报告：
- `mc-agent-reference/RESEARCH-3-5.md` — Mineflayer/Voyager/MindCraft/SiliconeDolls 对比
- `mc-agent-reference/research-airi-3-5.md` — AIRI 认知架构详细分析
