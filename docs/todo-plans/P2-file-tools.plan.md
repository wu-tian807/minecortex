---
name: "P2: 基础文件工具 + 路径管理器 + Terminal 管理"
order: 2
overview: "补全 6 个文件工具 + 通用路径管理器(PathManager) + manage_brain + bash 工具的 Terminal 实例管理。终端日志保存在 <PROJECT_ROOT>/workspace/terminals/ 中，通过 PathManager 定位而非硬编码。"
depends_on: ["P0"]
unlocks: ["P8-扩展:用户命令系统"]
parallel_group: "phase-1"
todos:
  - id: path-manager
    content: "新建 src/core/path-manager.ts — PathManager 类: 统一管理项目级目录(workspace/terminals等) + brain-aware resolvePath + isBrainLocalPattern + 权限校验"
  - id: read-file
    content: "新建 tools/read_file.ts — brain? 参数 + 多模态感知(图片→ContentPart)"
  - id: write-file
    content: "新建 tools/write_file.ts — brain? 参数 + 权限校验"
  - id: edit-file
    content: "新建 tools/edit_file.ts — brain? 参数 + 字符串替换"
  - id: glob
    content: "新建 tools/glob.ts — brain? 参数 + 文件模式匹配"
  - id: grep
    content: "新建 tools/grep.ts — brain? 参数 + 内容搜索"
  - id: terminal-manager
    content: "新建 src/core/terminal-manager.ts — TerminalManager 类: 通过 PathManager.terminals() 定位日志目录 + create/get/list/kill/readOutput"
  - id: bash
    content: "新建 tools/bash.ts — child_process.exec + TerminalManager 集成 + env 合并 + 超时控制 + 长命令自动后台化"
  - id: env-isolation
    content: "bash 工具支持 brain.json 的 env 字段, 执行时合并环境变量({ ...process.env, ...brainEnv }) + 可选 venv/nvm 自动检测"
  - id: manage-brain
    content: "新建 tools/manage_brain.ts — list/start/stop/restart"
  - id: migrate-send-message
    content: "修改 tools/send_message.ts — 迁移到 input_schema + priority/silent 参数"
  - id: delete-read-state
    content: "删除 tools/read_state.ts"
---

# P2: 基础文件工具 + 路径管理器 + Terminal 管理

## 目标

补全 MineClaw 的基础工具集（文件操作 + bash + 脑管理），
实现**通用路径管理器 (PathManager)**，以及 **bash 工具的 Terminal 实例管理**。

## 可并行

与 P1、P3、P4、P5、P6 完全并行。

## PathManager — 通用路径管理器（核心）

### 设计原则

**所有路径解析都通过 PathManager，不写死任何路径字符串。**

PathManager 是项目级别的路径注册中心，管理所有已知目录的位置。
工具、Loader、TerminalManager 等通过 PathManager 查询路径，而非硬编码。

```typescript
class PathManager {
  private projectRoot: string;
  private knownDirs: Map<string, string>;  // 逻辑名 → 相对路径

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    // 注册已知目录（可通过 minecortex.json 覆盖）
    this.knownDirs = new Map([
      ["brains",        "brains"],
      ["tools",         "tools"],
      ["slots",         "slots"],
      ["subscriptions", "subscriptions"],
      ["directives",    "directives"],
      ["skills",        "skills"],
      ["workspace",     "workspace"],
      ["terminals",     "workspace/terminals"],
      ["key",           "key"],
    ]);
  }

  // 获取已知目录的绝对路径
  dir(name: string): string {
    const rel = this.knownDirs.get(name);
    if (!rel) throw new Error(`Unknown directory: ${name}`);
    return join(this.projectRoot, rel);
  }

  // 项目根目录
  root(): string { return this.projectRoot; }

  // 脑目录
  brainDir(brainId: string): string {
    return join(this.dir("brains"), brainId);
  }

  // brain-aware 路径解析
  resolve(input: { path: string; brain?: string }, callerBrainId: string): string {
    if (input.brain) {
      return join(this.brainDir(input.brain), input.path);
    }
    if (this.isBrainLocalPattern(input.path)) {
      return join(this.brainDir(callerBrainId), input.path);
    }
    return join(this.projectRoot, input.path);
  }

  // 权限校验
  checkPermission(absPath: string, op: "read" | "write", callerBrainId: string, evolve: boolean): boolean;

  private isBrainLocalPattern(path: string): boolean {
    const patterns = [
      "soul.md", "brain.json",
      /^(skills|tools|subscriptions|slots|directives|sessions|memory|workspace|src)\//,
    ];
    return patterns.some(p => typeof p === "string" ? path === p : p.test(path));
  }
}
```

### 为什么是 PathManager 而不是 resolvePath 函数

- **集中管理**：所有已知目录在一个地方注册，项目结构变更只需改一处
- **可配置**：未来可通过 `minecortex.json` 的 `paths` 字段覆盖默认目录
- **消费方解耦**：TerminalManager 通过 `pathManager.dir("terminals")` 定位日志目录，不关心具体路径
- **一致性**：所有工具、Loader、Manager 共用同一个 PathManager 实例

### 终端路径明确性

`workspace/terminals/` 位于 **项目根** (`<PROJECT_ROOT>/workspace/terminals/`)，
**不是** `brains/<id>/` 下的目录。这通过 PathManager 的 `dir("terminals")` 统一获取：

```
<PROJECT_ROOT>/
├── brains/
│   ├── listener/           ← 脑专属目录（每个脑独立）
│   └── responder/
├── workspace/              ← 项目级共享工作区
│   └── terminals/          ← 所有脑共享的终端日志目录
│       ├── active.json
│       └── t_xxx.log
├── tools/                  ← 全局工具
└── ...
```

## Terminal 管理

### 设计灵感

参考 Cursor IDE 的 Shell 工具机制：

- Cursor Agent 执行 shell 命令时，输出写入 `terminals/{id}.txt`
- 长时间运行的命令被后台化，Agent 通过读取 terminal 文件监控状态
- Agent 通过返回值中的 Shell ID 知道对应哪个 terminal 文件

### TerminalManager 类

```typescript
class TerminalManager {
  private terminals: Map<string, TerminalInstance>;
  private pathManager: PathManager;

  constructor(pathManager: PathManager) {
    // 通过 PathManager 定位终端日志目录，不硬编码
    this.terminalsDir = pathManager.dir("terminals");
    ensureDirSync(this.terminalsDir);
  }

  async exec(command: string, opts: ExecOpts): Promise<ExecResult>;
  get(id: string): TerminalInstance | undefined;
  list(filter?: { brainId?: string; status?: string }): TerminalInstance[];
  kill(id: string): boolean;
  readOutput(id: string, opts?: { tail?: number }): string;
  cleanup(maxAge?: number): void;
}

interface ExecResult {
  terminalId: string;
  stdout: string;
  exitCode?: number;
  backgrounded: boolean;
  hint?: string;
}
```

### terminal log 格式

```
---
id: t_1709123456_a3f2
pid: 12345
cwd: /home/aw/Desktop/gamer/mineclaw
command: python train.py
brain: responder
started_at: 2025-02-28T20:17:00.000Z
---
Epoch 1/10: loss=0.523
Epoch 2/10: loss=0.412
...
---
exit_code: 0
elapsed_ms: 45230
---
```

### bash 工具与 Terminal 的集成

```typescript
// tools/bash.ts
async execute(args, ctx) {
  const result = await ctx.terminalManager.exec(args.command, {
    cwd: ctx.workspace,
    env: { ...process.env, ...resolveEnv(brain.config.env) },
    brainId: ctx.brainId,
    timeoutMs: args.timeout ?? 30000,
  });

  if (result.backgrounded) {
    // 通过 PathManager 解析路径，不硬编码
    const logPath = join("workspace/terminals", `${result.terminalId}.log`);
    return `${result.stdout}\n[命令已后台化] terminalId: ${result.terminalId}\n查看输出: read_file({ path: "${logPath}" })`;
  }

  return result.stdout || `(exit code: ${result.exitCode})`;
}
```

### 脑如何知道当前运行的终端

1. **bash 工具返回值**：短命令直接返回 stdout + exitCode；长命令返回 terminalId + 查看路径
2. **read_file 查看日志**：`read_file({ path: "workspace/terminals/t_xxx.log" })`
3. **brain_board**：`activeTerminals` 字段（工具执行后自动注册）
4. **glob 扫描**：`glob({ pattern: "workspace/terminals/*.log" })`

## 环境隔离

### brain.json env 字段

`brain.json` 支持 `env` 字段，bash 工具执行时自动合并环境变量：

```json
// brains/builder/brain.json
{
  "model": "gemini-2.5-flash",
  "env": {
    "PYTHONPATH": "./lib",
    "NODE_ENV": "development"
  }
}
```

bash 工具执行时：
```typescript
const env = { ...process.env, ...resolveEnv(brainConfig.env) };
child_process.exec(command, { env, cwd });
```

### 可选：venv/nvm 自动检测

bash 工具可检测 brain 目录下的环境标记文件并自动激活：

- `.venv/` 存在 → 自动 `source .venv/bin/activate` 前置
- `.nvmrc` 存在 → 自动 `nvm use` 前置
- `.python-version` 存在 → 自动 `pyenv shell` 前置

此功能为可选优化，不阻塞核心流程。

## 权限控制

| 操作 | 自身脑目录 | 其他脑目录 | 全局目录 | src/(框架) |
|------|----------|----------|---------|-----------|
| 读 | 始终 | 始终 | 始终 | 始终 |
| 写 | 始终 | evolve模式 | evolve模式 | 禁止 |

## 涉及文件

| 操作 | 文件 |
|------|------|
| 新建 | `src/core/path-manager.ts` |
| 新建 | `src/core/terminal-manager.ts` |
| 新建 | `tools/read_file.ts` |
| 新建 | `tools/write_file.ts` |
| 新建 | `tools/edit_file.ts` |
| 新建 | `tools/glob.ts` |
| 新建 | `tools/grep.ts` |
| 新建 | `tools/bash.ts` |
| 新建 | `tools/manage_brain.ts` |
| 修改 | `tools/send_message.ts` |
| 删除 | `tools/read_state.ts` |

## 参考实现

- `references/agentic_os/src/tools/` — 6 个文件工具实现
- `references/agent_fcos/docs/11_runtime/workspace.md` — Zone 路径设计
- Cursor IDE terminals 机制 — TerminalManager 设计灵感
