# Bundle 环境隔离设计方案

> 作者：天旭（基于霜雪原方案 `brain-sandbox-design.md` 评估后重写）  
> 状态：设计评估文档，待决策  
> 环境：Linux 6.6.98（TencentOS），Python 3.11、Node v22 已装，unshare 可用  
> 更新：经实测验证，namespace/overlayfs 方案完全可行，实现代价远低于预估

---

## 一、需求重新明确

"一个 bundle 一个环境"这句话有两个不同的含义，需要先分清楚：

| 含义 | 解释 | 重要程度 |
|------|------|----------|
| **运行时一致** | bundle 内所有 brain 用同一版本的 python/node，用同一组 pip/npm 包 | ★★★★★ 核心 |
| **brain 间隔离** | 不同 brain 的临时文件、browser session、shell 历史互不干扰 | ★★★★☆ |
| **进程安全隔离** | brain 看不到宿主机敏感目录，不能破坏其他 brain | ★★★★☆ 推荐做 |
| **文件系统隔离** | namespace/overlayfs 级别，绝对路径也被拦截 | ★★★☆☆ 可做，代价不高 |

**当前主要痛点**：

1. brain 用 `shell` 工具跑 Python 脚本，装的包可能各不相同，或依赖宿主机版本
2. 需要 browser 的 brain 没有隔离的 browser instance，设计一个还没有落地
3. bundle 目前没有"共享依赖包"的机制，只有共享工作目录

---

## 二、现状分析

### 2.1 当前框架已有的能力

```
强项：
  pathManager 三层模型         — global / bundle / local(brain) 完全符合需求
  brain.json 扩展性好          — 加 sandbox 配置字段不需要改框架骨架
  TerminalManager 按 brain 隔离 — shell session 已经是 brain 级，不共享
  brain 生命周期钩子           — shutdown/free 适合做资源回收
  bundle/shared 目录已存在     — env/, lib/, state/, workspace/ 子目录已有

弱项：
  workspace 语义不统一         — ConsciousBrain 用 bundle/shared/workspace，
                                  路径 resolve 却默认落到 brain local workspace
  checkPermission 只是逻辑检查  — 没有 OS 级保证，不是真隔离
  TerminalManager 直接用宿主 bash — 没有 namespace，brain 能访问任何宿主路径
  没有浏览器资源管理层          — BrowserManager 完全空白
  没有 bundle 级包管理机制      — 每个 brain 各自为政，包版本不可控
```

### 2.2 当前服务器环境（实测）

```
宿主机：
  Python    3.11.6 (/usr/bin/python3)
  Node      v22.22.0
  npm/pip   已可用
  unshare   已可用（util-linux 2.39.1）
  overlayfs 内核支持 ✓
  user namespace max: 62770 ✓

未安装：
  mise  ✗  (霜雪方案依赖，需额外安装)
  uv    ✗  (霜雪方案依赖，需额外安装)
  playwright  ✗  (browser 需要)
```

---

## 三、霜雪原方案评估

### 3.1 方案核心思路（正确的部分）

霜雪方案的分层安全模型、目录结构、浏览器隔离思路在方向上是对的。  
特别是这三点完全赞同并直接复用：

- `bundle/shared/browsers/` 存储 Playwright 二进制，所有 brain 共用
- `brains/{id}/.browser-data/` 存储 brain 私有 profile，严格隔离
- `brain.json` 里 `sandbox.browser` 配置字段

### 3.2 方案中过重的部分

| 方案特性 | 实现代价 | 解决的问题 | 评估 |
|---------|---------|-----------|------|
| Mount Namespace + OverlayFS | 高，改变 shell 启动模型 | 绝对路径被拦截 | 当前非必须，可后置 |
| User Namespace | 中，与 TerminalManager 耦合 | 进程身份隔离 | 安全加固阶段再做 |
| `mise` 管理 runtime | 中，需安装和维护 | runtime 版本管理 | 宿主机 Python 3.11/Node 22 完全够用 |
| `uv` 代替 pip | 低，但依赖安装 | 快 100x | 加速价值有，但非核心隔离需求 |
| `seccomp` 系统调用过滤 | 高，需内核接口 | 进程逃逸防护 | 很高安全需求才值得 |

### 3.3 关键问题：mise 是不必要的复杂度

当前宿主机 Python 3.11、Node v22 本身就足够稳定，bundle 之间未必需要不同 runtime 版本。  
**真正需要的不是"多版本 runtime 管理"，而是"bundle 级包隔离"**。

这两件事区别很大：

- mise 解决的是"这个 bundle 要用 Python 3.12，那个要用 Python 3.10"
- 当前真正的需求是"所有 brain 共用同一套 pip 包，而不是每个 brain 乱装"

前者用 `venv` 就够了。

---

## 四、推荐方案：分层渐进，轻量优先

### 核心原则

1. **不引入新依赖**，先把现有工具链（Python venv、npm prefix、unshare）用到位
2. **分阶段实施**，先做有实际收益的，再做安全加固，最后做内核级隔离
3. **browser 是第一个复杂能力**，单独设计好 BrowserManager，作为"长生命周期资源"的范本

### 三阶段路线（重新修订）

> **重要更新**：经实测，当前服务器 user namespace + mount namespace + overlayfs 全部可用，
> 且与 TerminalManager 的 spawn+stdin pipe 模式完全兼容，50 行代码可实现 shell 进程隔离。
> 原文档"Phase 3 搁置"的判断是过于保守的，已修正如下：

```
Phase 1 (立刻做) — bundle venv + BrowserManager + base.env 注入
Phase 2 (紧接做) — shell namespace sandbox（改动极小，与 Phase 1 并行可行）
Phase 3 (长期)   — seccomp 系统调用过滤（真正复杂的部分，按需做）
```

**Phase 1 和 Phase 2 可以认为是同一批工作**，因为 namespace 改动只集中在 `createSession()` 一个函数。

---

## 五、Phase 1：bundle venv + BrowserManager（推荐优先实现）

这是最轻量同时能满足核心需求的方案。

### 5.1 目录结构

```
bundle/
├── shared/
│   ├── env/
│   │   └── base.env               ← bundle 级共享环境变量（已有目录，文件待创建）
│   ├── lib/                       ← 已有目录
│   │   └── python/
│   │       └── venv/              ← bundle 级 Python 虚拟环境
│   │           ├── bin/python3
│   │           ├── bin/pip
│   │           └── lib/...
│   │   └── node_modules/          ← bundle 级 npm 包
│   │       └── package.json
│   ├── browsers/                  ← Playwright 浏览器二进制（按需安装）
│   │   └── chromium-*/
│   └── workspace/                 ← 已有，AI 共享工作区
│
└── brains/
    └── coder/
        ├── brain.json             ← 加 sandbox 字段
        ├── .browser-data/         ← coder 的浏览器 profile（严格隔离）
        └── workspace/             ← 按 brain 私有工作区
```

### 5.2 base.env 设计

```bash
# bundle/shared/env/base.env
# 框架进程读取后注入到 shell 执行环境，brain 不能直接访问此文件

# bundle 级 Python venv（覆盖宿主机 pip 包）
VIRTUAL_ENV=/path/to/bundle/shared/lib/python/venv
PATH=/path/to/bundle/shared/lib/python/venv/bin:$PATH
PYTHONPATH=/path/to/bundle/shared/lib/python/venv/lib/python3.11/site-packages

# bundle 级 npm 包
NODE_PATH=/path/to/bundle/shared/lib/node_modules

# API Keys（在此统一管理，通过注入进入进程）
ANTHROPIC_API_KEY=sk-ant-...

# Playwright 浏览器路径（有 browser 的 brain 会用到）
PLAYWRIGHT_BROWSERS_PATH=/path/to/bundle/shared/browsers
```

与宿主机 env 的合并策略：

```typescript
// src/terminal/env-builder.ts (新建)
function buildBrainShellEnv(
  brainId: string,
  pathManager: PathManagerAPI,
  extraEnv?: Record<string, string>,
): NodeJS.ProcessEnv {
  const bundleRoot = pathManager.bundle().root();
  const baseEnvPath = pathManager.bundle().sharedDir("env") + "/base.env";
  const baseEnv = existsSync(baseEnvPath) ? parseEnvFile(baseEnvPath) : {};

  // 不展开 process.env 中敏感部分（SSH_AUTH_SOCK 等），但保留必要系统变量
  const safeHostEnv = pickSafeHostEnv(process.env);

  return {
    ...safeHostEnv,
    ...baseEnv,          // bundle 层覆盖
    ...extraEnv,         // tool 调用时 per-call 覆盖
    BRAIN_ID: brainId,
    BRAIN_DIR: pathManager.local(brainId).root(),
  };
}

// 只保留必要的宿主机环境变量
function pickSafeHostEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const SAFE_KEYS = ["HOME", "USER", "SHELL", "TERM", "LANG", "LC_ALL", "TZ", "DISPLAY"];
  const result: NodeJS.ProcessEnv = {};
  for (const key of SAFE_KEYS) {
    if (env[key]) result[key] = env[key];
  }
  return result;
}
```

### 5.3 Browser 环境设计（修订：进程模型，不是 Manager 模型）

> **架构更正**：browser 不需要在框架核心层写 BrowserManager，  
> 和 shell 的逻辑完全一致——框架提供"环境"（namespaced 进程），brain 用工具操作它。

#### 5.3.1 对比：shell 模式 vs browser 模式

```
shell 的模式（现有）：
  环境 = namespace 内的 bash 进程（由 TerminalManager 管理）
  工具 = shell tool，写命令进 stdin，读 stdout 返回
  brain 不感知 bash 怎么启动/管理的，只用 shell tool

browser 的模式（同理）：
  环境 = namespace 内的 Chromium 进程（由 shell tool 启动）
  工具 = browser_* tools，通过 CDP (Chrome DevTools Protocol) 发命令
  brain 不感知 Chromium 怎么运行的，只用 browser_* tools
```

brain 用 `shell` 启动浏览器，然后用 `browser_*` 操作它。  
框架核心层**零改动**，没有 BrowserManager，没有新 singleton。

#### 5.3.2 browser 进程的启动与隔离

brain 用 `shell` tool 启动浏览器：

```bash
# brain 在 namespace 内执行（自动继承 namespace 隔离）
chromium \
  --headless \
  --remote-debugging-port=0 \          # 0 = 随机端口，写入 DevToolsActivePort 文件
  --remote-debugging-pipe \            # 或 pipe 模式
  --user-data-dir="$BRAIN_DIR/.browser-data/" \
  --no-sandbox \                       # 已在 namespace 内，不需要 Chrome 沙箱
  --disable-dev-shm-usage \
  &

# 浏览器启动后，端口写在：
# $BRAIN_DIR/.browser-data/DevToolsActivePort
```

隔离自动满足：
- 进程在 namespace 里，`~/.ssh`、其他 brain 目录看不到
- `--user-data-dir` 是 brain 私有目录 → cookie/localStorage/缓存完全隔离
- 每个 brain 各自的进程，互不影响

#### 5.3.3 browser_* 工具：通过 CDP 操作

工具层通过 Chrome DevTools Protocol（纯 JSON over WebSocket/pipe）和浏览器通信：

```typescript
// tools/builtin/browser_navigate.ts
import WebSocket from "ws";   // 唯一依赖，或用 node 内置 fetch

export default {
  name: "browser_navigate",
  description: "在此 brain 的浏览器中打开 URL（需先用 shell 启动浏览器）",
  input_schema: {
    type: "object",
    properties: {
      url:  { type: "string", description: "目标 URL" },
      port: { type: "integer", description: "浏览器调试端口（从 .browser-data/DevToolsActivePort 读取）" },
    },
    required: ["url"],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const brainRoot = ctx.pathManager.local(ctx.brainId).root();
    const port = args.port ?? await readBrowserPort(brainRoot);
    if (!port) return "Error: 浏览器未启动，请先用 shell 工具启动 chromium";

    // 通过 CDP 发命令
    const result = await cdpNavigate(port, String(args.url));
    return `已导航到: ${result.title}\nURL: ${result.url}`;
  },
};

// 读取 chromium 写入的端口文件
async function readBrowserPort(brainRoot: string): Promise<number | null> {
  try {
    const raw = await readFile(`${brainRoot}/.browser-data/DevToolsActivePort`, "utf-8");
    return parseInt(raw.split("\n")[0], 10);
  } catch { return null; }
}
```

如果觉得 CDP 太底层，可以用 `playwright.connect({ wsEndpoint })` 接入已有进程，也不需要 BrowserManager：

```typescript
// 连接已在运行的 chromium，而不是 launch 一个新的
const browser = await chromium.connectOverCDP(`http://localhost:${port}`);
const page = browser.contexts()[0]?.pages()[0] ?? await browser.newPage();
await page.goto(url);
// 用完 disconnect，不 close（不杀进程）
await browser.close();  // close 断连，不 close 进程
```

#### 5.3.4 浏览器二进制：bundle 共享

浏览器二进制的安装仍然是 bundle 级共享（约 200MB，只装一次）：

```bash
# brain 用 shell tool 执行，或框架 bootstrap 时执行
PLAYWRIGHT_BROWSERS_PATH=$BUNDLE_DIR/shared/browsers \
  npx playwright install chromium
```

二进制路径注入到 namespace 的 env 里：

```bash
# base.env 里
PLAYWRIGHT_BROWSERS_PATH=/bundle/shared/browsers
# chromium 启动时会自动找这个路径下的二进制
```

#### 5.3.5 brain.json 配置（只需 browser 相关 env，无需 manager 配置）

```jsonc
{
  "env": {
    "PLAYWRIGHT_BROWSERS_PATH": "/bundle/shared/browsers"
  }
}
```

仅此而已。browser 进程由 brain 自己决定什么时候启动，不需要框架感知。

### 5.4 bundle venv 初始化流程

```typescript
// src/bundle/init.ts (新建)

async function ensureBundleVenv(bundleRoot: string): Promise<void> {
  const venvPath = join(bundleRoot, "shared/lib/python/venv");
  if (existsSync(join(venvPath, "bin/python3"))) return; // 已创建

  console.log("[bundle] 初始化 Python venv...");
  await exec(`python3 -m venv ${venvPath}`);
  await exec(`${venvPath}/bin/pip install --upgrade pip`);
  console.log("[bundle] venv 已就绪:", venvPath);
}

async function ensureBundleNodeModules(bundleRoot: string): Promise<void> {
  const nmPath = join(bundleRoot, "shared/lib/node_modules");
  const pkgPath = join(bundleRoot, "shared/lib/package.json");
  if (!existsSync(pkgPath)) {
    await writeFile(pkgPath, JSON.stringify({ name: "bundle-shared", private: true }, null, 2));
  }
  // 只在 package.json 声明了依赖时才安装
}

// Scheduler.start() 时调用
export async function ensureBundleEnvironment(bundleRoot: string): Promise<void> {
  await ensureBundleVenv(bundleRoot);
  await ensureBundleNodeModules(bundleRoot);
  await generateBaseEnvFile(bundleRoot);
}
```

---

## 六、Phase 2：shell namespace sandbox（实测可行，代价极小）

> **实测结论**（已在本机验证）：
> - user namespace + mount namespace：✅ 可用
> - user ns 内 overlayfs：✅ 可用  
> - bind mount 遮蔽 `~/.ssh`：✅ 可用（实测 ls ~/.ssh: 0 files）
> - `/tmp` 私有化：✅ 可用
> - Node.js `spawn + stdin pipe`（TerminalManager 真实模式）：✅ 兼容
> - 子进程（python subprocess 等）继承 namespace：✅ 自动继承

### 6.1 只需改 `createSession()` 一个函数

改动极其集中，现有其余逻辑完全不变：

```typescript
// src/terminal/manager.ts — createSession() 修改部分

private createSession(baseBrainId: string, initialCwd?: string, initScript?: string): ShellSession {
  const brainEnv  = this.brainEnvCache.get(baseBrainId) ?? {};
  const shellPath = this.resolveShellPath(brainEnv);
  const sessionCwd = this.resolveSessionCwd(initialCwd);
  const brainRoot  = this.pathManager.local(baseBrainId).root();

  // sandbox 初始化脚本：在 namespace 内、bash 接管前执行一次
  const nsSetup = [
    `mkdir -p '${brainRoot}/.home' '${brainRoot}/.tmp'`,
    // 遮蔽 ~/.ssh（最高优先级安全需求）
    `mount --bind '${brainRoot}/.home' "$HOME/.ssh" 2>/dev/null || true`,
    // 私有化 /tmp
    `mount --bind '${brainRoot}/.tmp' /tmp`,
    // 恢复 cwd（sandbox 内再 cd 一次）
    initScript ?? "",
  ].filter(Boolean).join("\n");

  // fallback: 检查 unshare 是否可用
  const child = this.unshareAvailable
    ? spawn("unshare", ["--mount", "--user", "--map-root-user",
                        shellPath, "--norc", "--noprofile"], {
        cwd: sessionCwd,
        env: { ...buildBrainShellEnv(baseBrainId, this.pathManager, brainEnv),
               PS1: "", PS2: "" },
        stdio: ["pipe", "pipe", "pipe"],
      })
    : spawn(shellPath, ["--norc", "--noprofile"], {
        cwd: sessionCwd,
        env: { ...process.env, ...brainEnv, PS1: "", PS2: "" },
        stdio: ["pipe", "pipe", "pipe"],
      });

  // 写入 namespace 初始化（通过 stdin，与现有 initScript 机制一致）
  if (this.unshareAvailable) {
    try { child.stdin?.write(nsSetup + "\n"); } catch { /* ignore */ }
  }

  // ↓ 以下代码完全不变（session 对象构建、stdout 监听、marker 机制等）
  // ...
}
```

### 6.2 隔离效果

```
启用 namespace 后，brain 的 shell session 里：

  ✅ ~/.ssh               → bind mount 为 brain 私有空目录，原密钥不可见
  ✅ /tmp                 → bind mount 为 brain/.tmp/，各 brain 独立
  ✅ 子进程（python/node） → 自动继承 namespace，无需额外处理
  ✅ 绝对路径              → /usr/bin/python3 仍指向宿主机（如需隔离需加 overlayfs）
  ✅ background task       → 超时后新建 session 时重新执行 nsSetup，行为一致

  ❌ 宿主机 HOME 下其他目录 → 仍可见（只遮蔽了 .ssh，如需全隔离加更多 bind mount）
  ❌ 其他 brain 的目录     → 可见（权限控制靠 chmod 700，不靠 namespace）
```

### 6.3 可选：overlayfs 隔离 /usr/local（防绝对路径绕过）

如果需要防止 `python3 /usr/bin/python3 script.py` 这种绕过 venv 的场景：

```typescript
// 在 nsSetup 开头加：
const olSetup = [
  `mkdir -p /tmp/ol_upper /tmp/ol_work /tmp/ol_merged`,
  `mount -t overlay overlay \\`,
  `  -o lowerdir=/usr/local,upperdir=/tmp/ol_upper,workdir=/tmp/ol_work \\`,
  `  /tmp/ol_merged`,
  `mount --bind /tmp/ol_merged /usr/local`,
].join("\n");
```

这样 `/usr/local/bin/python3` 就会被 bundle venv 的 shim 覆盖。已实测在本机 user namespace 内可用。

### 6.4 命令黑名单（框架层，不依赖 OS，与 namespace 互补）

```typescript
// src/terminal/command-validator.ts
const DANGEROUS_PATTERNS: RegExp[] = [
  /\bsudo\b/,    /\bsu\s/,
  /\bnsenter\b/, /\bunshare\b/,        // 防 namespace 逃逸/嵌套
  /\brm\s+.*-[a-z]*rf[a-z]*\s+\/(?:\s|$)/,  // rm -rf /
  /\bdd\b.*of=\/dev/,
  /\/etc\/shadow/, /~\/\.ssh/,
];
```

---

## 七、Phase 3：seccomp 系统调用过滤（真正复杂的部分）

这才是真正需要"搁置"的部分。

seccomp 和 namespace 不是一个量级的事情：

```
namespace / overlayfs：
  - 纯 shell 脚本就能配置
  - 内核功能默认开启
  - 出错会显式报错，易调试

seccomp：
  - 需要 C binding 或 Rust（libseccomp / prctl 系统调用）
  - 规则集设计复杂（漏一个 syscall 功能就坏掉）
  - 出错是 SIGSYS 终止进程，调试困难
  - TypeScript/Node.js 生态支持有限
```

**什么时候才需要做 seccomp**：
- brain 执行来自外部/不可信来源的代码（用户粘贴的、爬取的）
- 需要防御 namespace 逃逸（极高安全需求）
- 多租户 SaaS 场景

当前 AI agent 场景：namespace 已经足够。

---

## 八、workspace 语义统一（前置工作，Phase 1 之前要做）

目前存在一个双轨问题，在做任何环境隔离之前需要先统一：

```
问题：
  ConsciousBrain.workspace → bundle/shared/workspace   (Scheduler 里写死)
  pathManager.resolve()    → bundle/brains/{id}/workspace/  (路径解析默认值)

效果：
  ctx.workspace = "bundle/shared/workspace"  ← AI 认为的工作目录
  pathManager.resolve("foo.txt", "coder")
    = "bundle/brains/coder/workspace/foo.txt"  ← 工具实际写入的位置

这两个不一致，AI 在用相对路径时可能感到困惑。
```

建议修改方向（二选一）：

**方案 A（推荐）**：将 brain 私有 workspace 作为工作目录
```
workspace: pathManager.local(brainId).root() + "/workspace"
```
优点：AI 的工作文件是 brain 私有的，bundle 共享目录用显式 `bundle/shared/` 前缀访问。

**方案 B**：保持 shared workspace，但明确语义
```
workspace: pathManager.bundle().sharedDir("workspace")
pathManager.resolve() 也改成默认 shared workspace
```
优点：多 brain 合作时共享文件更自然。

我建议**方案 A**，更符合"一个 brain 一个私有空间"的直觉，合作通过 `bundle/shared/` 显式完成。

---

## 九、实施优先级与成本

| 任务 | 阶段 | 估计工作量 | 依赖 |
|------|------|-----------|------|
| 统一 workspace 语义（方案 A） | 前置 | 小（改 Scheduler 1 行 + 测试） | 无 |
| `bundle/shared/env/base.env` 生成与注入 | Phase 1 | 小（新建 env-builder.ts） | workspace 统一 |
| bundle Python venv 初始化 | Phase 1 | 小（调用 python3 -m venv） | 无 |
| TerminalManager 使用 base.env 注入 | Phase 1 | 小（改 createSession env 构建） | base.env |
| **namespace sandbox for shell** | **Phase 2** | **小（改 createSession 约 30 行）** | **无** |
| **bind mount 隔离 ~/.ssh、/tmp** | **Phase 2** | **小（nsSetup 脚本拼接）** | **namespace** |
| **overlayfs 隔离 /usr/local（可选）** | **Phase 2** | **小（nsSetup 多加几行）** | **namespace** |
| 命令黑名单（command-validator.ts） | Phase 2 | 小（独立模块） | 无 |
| `pnpm add ws`（CDP WebSocket 客户端） | Phase 1 | 极小 | 无 |
| `npx playwright install chromium`（bundle 共享，手动一次） | Phase 1 | 极小（命令行） | 无 |
| browser_* 工具实现（navigate/screenshot/click/eval/close） | Phase 1 | 中（~200 行，无 Manager） | ws 或 playwright connect |
| ~~BrowserManager~~（不再需要） | ~~Phase 1~~ | ~~已移除~~ | — |
| seccomp 系统调用过滤 | Phase 3 | 大（需 native bindings） | Phase 2 |

---

## 十、Phase 1 之后的目录结构全貌

```
bundle/
├── shared/
│   ├── env/
│   │   └── base.env               ← 框架生成，brain 不可直接读
│   ├── lib/
│   │   ├── python/
│   │   │   └── venv/              ← bundle 级 Python 环境
│   │   └── node_modules/          ← bundle 级 npm 包（按需）
│   ├── browsers/                  ← Playwright 浏览器二进制（按需安装）
│   │   └── chromium-1179/
│   ├── state/                     ← 已有（bundle 级共享状态）
│   └── workspace/                 ← 已有（AI 可写入的共享文档区）
│
└── brains/
    ├── coder/
    │   ├── brain.json             ← 加 sandbox.browser 字段
    │   ├── soul.md
    │   ├── sessions/
    │   ├── workspace/             ← coder 私有工作目录（Phase 1 改为此）
    │   └── .browser-data/         ← coder browser profile（enabled 时创建）
    └── talker/
        ├── brain.json
        ├── workspace/
        └── （无 .browser-data，未启用 browser）
```

---

## 十一、与霜雪原方案的对比

| 特性 | 霜雪原方案 | 本方案 Phase 1+2 |
|------|-----------|-----------------|
| runtime 版本管理 | mise（需安装） | 宿主机 Python 3.11 / Node 22（已有） |
| Python 包隔离 | uv + bundle shared lib | Python venv（标准库，无需安装） |
| browser 二进制 | bundle/shared/browsers ✓ | 同左 ✓ |
| browser 实例隔离 | brain 级 profile ✓ | 同左 ✓ |
| shell 进程隔离 | Mount + User Namespace | **同左 ✓（已实测可行，改动极小）** |
| `~/.ssh` 隐藏 | bind mount ✓ | **同左 ✓（已实测）** |
| `/tmp` 私有化 | bind mount ✓ | **同左 ✓（已实测）** |
| 文件系统 overlayfs | /usr/local 覆盖 ✓ | **同左 ✓（已实测 user ns 内可用）** |
| 命令拦截 | 框架黑名单 ✓ | 同左 ✓ |
| seccomp | 可选 | Phase 3，按需 |
| 适用场景 | 高安全需求 | **同等安全，实现更简单** |
| **前置工作** | 安装 mise + uv | **无需安装任何新工具** |
| **实现复杂度** | 高（mise 运维负担） | **中低（namespace 约 30 行）** |

---

## 十二、结论与建议（修订版）

1. **立刻做（前置）**：统一 workspace 语义（方案 A），改一行代码，消除长期隐患

2. **同期做（Phase 1 + 2 并行）**：
   - `bundle/shared/env/base.env` + env 注入到 TerminalManager
   - bundle Python venv + 注入 PATH
   - **`createSession()` 改为 `unshare` 启动，写 nsSetup init script**（约 30 行，已实测）
   - **bind mount 隔离 `~/.ssh`、私有化 `/tmp`**
   - 命令黑名单（validateShellCommand）
   - `browser_*` 工具集（brain 用 shell 启动 chromium，工具通过 CDP 操作）
   - **核心框架零改动，不写 BrowserManager**

3. **可选加强（Phase 2 延伸）**：
   - overlayfs 覆盖 `/usr/local`（防绝对路径绕过 venv，已实测可行）

4. **真正搁置（Phase 3）**：
   - seccomp 系统调用过滤（需 native bindings，调试困难，当前场景无必要）

**修正原来的结论**：namespace 隔离不需要搁置，它和 venv/browser 是同一批工作。  
真正复杂的只有 seccomp，而那是另一个数量级的安全需求。

**最终架构核心原则**：

> 框架提供**环境**（namespaced 进程、venv、隔离目录），  
> brain 用**工具**操作环境里的进程（shell 发命令，browser_* 发 CDP）。  
> 不在核心层维护 browser/db 等"长生命周期资源" 的 Manager 对象。

这和 shell 的设计哲学完全一致：TerminalManager 管 bash 进程，工具只是写命令进去。  
browser 同理：bash 进程启动 chromium，工具只是发 CDP 命令进去。  
未来如果要接数据库、MCP server，也是同样的范式——由 shell 在 namespace 里启动进程，工具负责协议对话。

---

*注：browser 是框架中第一个需要"长生命周期资源管理"的能力，BrowserManager 的设计范式适用于未来所有类似资源（MCP server 连接、数据库连接池等），建议把接口抽象做好。*
