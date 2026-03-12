# 教程一：Pack 构建与 Bundle 运行目录结构标准

MineCortex 采用了 `[Global -> Bundle -> Brain(Local)]` 三层架构，并引入了 **Pack（只读模板）** 与 **Bundle（读写运行实例）** 的隔离机制。

本教程将引导你了解如何构建一个标准的 Pack，以及当它被实例化为 Bundle 后，文件系统会发生什么变化。

## 1. 核心概念

*   **Pack (模板蓝图)**：存放在 `packs/` 目录下。它是**只读的**。它定义了一个应用或一组机器人的“骨架”，包括预设的脑区 (brains)、环境安装脚本 (`setup.sh`) 以及沙盒挂载声明 (`pack.json`)。
*   **Bundle (运行现场)**：存放在 `bundle/` 目录下。系统同一时间只有一个活跃的 Bundle。它是**可读写的**。Bundle 是从某个 Pack “解压缩”并执行完初始化脚本后生成的真实工作环境。所有的 AI 思考、对话记录、产生的文件、甚至是沙盒里的 `apt install` 依赖都存在这里。
*   **Backup (存档备份)**：存放在 `backups/` 目录下。它是对 `bundle/` 的全量 ZIP 压缩包（排除垃圾缓存），用于随时回档或切换。

---

## 2. 预期的 Pack 目录结构

当你想要创造一个全新的机器人组合时，你需要在 `packs/` 下新建一个目录，其标准结构如下：

```text
packs/my-awesome-pack/
├── pack.json                  # 【必填】声明包的基本信息与沙盒持久化目录
├── startup-scripts/           
│   └── setup.sh               # 【可选】系统级初始化脚本（安装环境等）
├── brains/                    # 【必填】预设的脑区模板
│   ├── talker/                # 示例脑区 1
│   │   ├── brain.json         # 脑区配置文件（指定模型参数、启用的能力）
│   │   └── soul.md            # 【必填】系统提示词与人设
│   └── coder/                 # 示例脑区 2
│       ├── brain.json
│       └── soul.md
├── tools/                     # 【可选】本 Pack 专用的全局工具
├── subscriptions/             # 【可选】本 Pack 专用的订阅源
└── slots/                     # 【可选】本 Pack 专用的记忆槽模板
```

### 2.1 `pack.json` 解析

这是 Pack 的身份证和“基建申请表”。

```json
{
  "id": "my-awesome-pack",
  "name": "我的超棒拓展包",
  "version": "1.0.0",
  "description": "包含了一个话痨和一个程序员的组合",
  "runtime": {
    "overlays": [
      {
        "target": "/opt/conda",
        "description": "如果你想用 setup.sh 装 miniconda，声明这个挂载点让它持久化"
      }
    ]
  }
}
```

### 2.2 `setup.sh` 的威力

这是一个 **System Terminal** 脚本，以 `root` 权限（在命名空间沙盒内）运行。
*   它可以执行 `sudo apt-get install python3-pip` 或 `curl ...`。
*   **这些命令不会污染你的真实宿主机！** 因为我们默认拦截了 `/usr/local`, `/etc`, `/var` 等目录。所有的写入都会被 OverlayFS 持久化到接下来要讲的 `bundle/` 目录里。
*   执行成功（`exit 0`）后，系统会在 `bundle/manifest.json` 中标记 `setupScriptRan: true`，下次启动自动跳过，**`startup-scripts/` 目录保留不删除**。如果你需要重新执行 setup（例如修改了脚本），只需将 `manifest.json` 中的 `setupScriptRan` 改回 `false` 即可。

---

## 3. 构建后的 Bundle 目录结构

当你在界面上（或通过命令）选择从 `my-awesome-pack` 创建新实例时，框架会生成唯一的 `bundle/` 目录。

```text
bundle/
├── manifest.json                  # 身份证 + 初始化断点状态（见下方说明）
├── startup-scripts/               # 从 Pack 复制过来，执行后保留（靠 manifest 防重跑）
│   └── setup.sh
├── state/
│   └── renderer.json              # 记录 UI 当前选中的是哪个脑区等临时状态
│
├── shared/                        # 【所有脑区共享的空间】
│   ├── env/
│   │   └── base.env               # 框架自动生成的底层环境变量（PYTHON_HOME/NODE_HOME 等）
│   ├── runtime/                   # 【框架预装的独立 Python & Node.js，不写 /usr/local】
│   │   ├── python/                # python-build-standalone 解压到此
│   │   └── node/                  # node-linux-x64 解压到此
│   ├── lib/                       # bundle 级 npm 共享包目录（package.json + node_modules/）
│   ├── sandbox/                   # 【环境隔离的魔法所在】
│   │   ├── mounts.json            # 继承自 pack.json，但可以热更新
│   │   ├── tmp/                   # 沙盒内的共享 /tmp
│   │   └── overlays/              # sudo apt 和 setup.sh 装的真实文件都在这！
│   └── workspace/                 # ★ 真正的共享工作区！所有脑区可以在这里互相读写文件
│
├── brains/                        # 本次运行实例的脑区 
│   ├── talker/                     
│   │   ├── brain.json             
│   │   ├── soul.md                
│   │   ├── .home/                 # ★ 挂载为该脑区的 $HOME (AI 眼里的 ~)
│   │   ├── .tmp/                  # 挂载为该脑区独占的 /tmp 垃圾堆 (不备份)
│   │   ├── sessions/              # 该脑区的对话历史
│   │   └── session.json           # 记录当前激活的 sessionId
│   └── coder/
│       └── ...
│
├── tools/                         # 从 Pack 复制过来的工具
└── subscriptions/                 
```

### 3.1 `manifest.json` 解析

Bundle 的"初始化断点"全靠这个文件，任何一步失败（断网、断电）都可以从中断处续跑：

```json
{
  "bundleId": "virtual-companion_zjxd",
  "source": {
    "type": "pack",
    "id": "virtual-companion",
    "version": "1.0.0"
  },
  "runtimeState": {
    "pythonInstalled": true,   // 独立 Python 已下载到 shared/runtime/python/
    "nodeInstalled": true,     // 独立 Node.js 已下载到 shared/runtime/node/
    "envInitialized": true,    // base.env 和各脑区 .env 已生成
    "setupScriptRan": true     // startup-scripts/setup.sh 已成功执行（exit 0）
  },
  "createdAt": "2026-03-11T14:15:49.283Z",
  "lastStartedAt": "2026-03-11T14:17:30.865Z"
}
```

**重跑某个步骤**：直接将对应字段改为 `false`，下次启动会从该步骤重新执行。例如想重跑 `setup.sh`：

```bash
# 编辑 bundle/manifest.json，将 setupScriptRan 改为 false
# 然后重启应用或执行：
npx tsx src/cli/bundle.ts restore <当前备份名>
```

### 3.3 双态终端 (Dual-State Terminal) 原理

这是本框架最核心的设计，保证了 AI 既能自由折腾环境，又不会搞坏宿主机：

1.  **System Terminal (系统级)**：在执行 `setup.sh` 时启动。它是 **Root** 态，默认拦截系统关键目录。
2.  **User Terminal (用户级)**：每个 Brain 启动时自己的 Shell。它是 **User** 态：
    *   继承 System 产生的环境变量（`base.env` 中的 `PYTHON_HOME`、`NODE_HOME` 等）。
    *   将 `bundle/brains/<id>/.home` 强行挂载为自己的 `$HOME` 目录。
    *   如果它想使用系统工具，它可以**无痛执行 `sudo apt ...`**（因为框架内做了 sudo 代理兼容）。

### 3.4 `shared/env/base.env` 的生成机制

`base.env` 由框架在初始化阶段**自动生成**（`BundleManager.initBaseEnv()`），`setup.sh` 可以在此基础上追加自定义变量，各脑区的 `.env` 文件则在 brain 层覆写。优先级：

```
process.env (宿主机)  <  base.env  <  brain 的 .env  <  exec() 调用时 per-call 传入
```

默认内容示例：

```bash
PYTHON_HOME=/path/to/bundle/shared/runtime/python
NODE_HOME=/path/to/bundle/shared/runtime/node
LD_LIBRARY_PATH=${PYTHON_HOME}/lib:${NODE_HOME}/lib:/usr/local/lib:/usr/local/lib64
PKG_CONFIG_PATH=${PYTHON_HOME}/lib/pkgconfig:/usr/local/lib/pkgconfig
```

---

## 4. CLI 快速命令速查

所有操作均在 `minecortex/` 根目录下执行：

```bash
# 查看可用 packs、backups 和当前 bundle 状态
npx tsx src/cli/bundle.ts list

# 从 pack 新建 bundle（会先自动备份当前 bundle）
npx tsx src/cli/bundle.ts load <pack-id>

# 手动保存当前 bundle 为备份
npx tsx src/cli/bundle.ts save <backup-name>

# 从备份恢复 bundle
npx tsx src/cli/bundle.ts restore <backup-name>
```

---

## 总结

制作一个机器人的流程现在变得非常清晰：
1. 建个 Pack 文件夹，写好 `pack.json` 和 `soul.md`。
2. 需要装底层环境？写进 `startup-scripts/setup.sh`。
3. 执行 `npx tsx src/cli/bundle.ts load <pack-id>`，剩下的交给 BundleManager 去孵化和运行了！
4. 任何步骤中断了？看 `bundle/manifest.json` 里哪个 `runtimeState` 字段是 `false`，从那里续跑即可。
