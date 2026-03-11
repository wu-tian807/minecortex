import { spawn, exec as execCb, type ChildProcess } from "node:child_process";
import { writeFile, appendFile, readFile, mkdir, unlink } from "node:fs/promises";
import { existsSync, statSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  TerminalManagerAPI,
  TerminalInstance,
  ExecOpts,
  ExecResult,
  PathManagerAPI,
} from "../core/types.js";
import { buildBrainShellEnv } from "./env-builder.js";
import { getFSWatcher } from "../fs/watcher.js";

const execAsync = promisify(execCb);

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_STDOUT_CAPTURE = 512_000;
const STATE_DIR = ".shell_state";

let terminalManagerInstance: TerminalManager | null = null;

// ─── Internal types ───

interface PendingCommand {
  marker: string;
  /** Small buffer used only for marker detection — NOT for log accumulation */
  markerBuf: string;
  onComplete: (exitCode: number | undefined) => void;
}

interface ShellSession {
  id: string;
  baseBrainId: string;
  process: ChildProcess;
  shellPath: string;
  pending: PendingCommand | null;
  /** Resolves when the session is idle and ready for the next command */
  ready: Promise<void>;
  markReady: (() => void) | null;
  terminalIds: Set<string>;
  spawnError?: Error;
}

// ─── Singleton helpers ───

export function initTerminalManager(pathManager: PathManagerAPI): TerminalManager {
  if (!terminalManagerInstance) {
    terminalManagerInstance = new TerminalManager(pathManager);
  }
  return terminalManagerInstance;
}

export function getTerminalManager(): TerminalManager {
  if (!terminalManagerInstance) {
    throw new Error("TerminalManager not initialized");
  }
  return terminalManagerInstance;
}

// ─── TerminalManager ───

export class TerminalManager implements TerminalManagerAPI {
  private terminals    = new Map<string, TerminalInstance>();
  private sharedShells = new Map<string, ShellSession>();
  private sessions     = new Map<string, ShellSession>();
  private terminalCounter = 0;
  private sessionCounter  = 0;
  /** 预构建好的完整 shell env，key = baseBrainId */
  private brainEnvCache   = new Map<string, NodeJS.ProcessEnv>();

  /** 幂等 init Promise — 第一次 init() 后复用 */
  private initPromise: Promise<void> | null = null;
  private _ready = false;
  /** FSWatcher 注册凭证，cleanup(0) 时释放，防止重复注册 */
  private watcherDisposables: Array<{ dispose(): void }> = [];
  /** 是否检测到宿主机支持 unshare --user --mount */
  unshareAvailable = false;

  constructor(private pathManager: PathManagerAPI) {}

  // ─── Lifecycle (init / isReady / ensureReady) ───

  isReady(): boolean { return this._ready; }

  async ensureReady(): Promise<void> {
    if (this._ready) return;
    // 无论 init() 是否已被调用，都通过 init() 确保初始化触发且等待完成
    await this.init();
  }

  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._doInit().then(() => { this._ready = true; });
    return this.initPromise;
  }

  private async _doInit(): Promise<void> {
    try {
      await execAsync("unshare --user --mount true");
      this.unshareAvailable = true;
    } catch {
      // namespace 不可用（如非特权容器），降级为普通 spawn
    }

    const w = getFSWatcher();
    if (w) {
      // mounts.json 变更 → overlay 结构改变，必须重建 shell 才能生效
      this.watcherDisposables.push(
        w.register(/^bundle\/shared\/sandbox\/mounts\.json$/, () => {
          if (!this._ready) return;
          console.log("[TerminalManager] mounts.json changed — restarting shells");
          this.killAllShells();
        })
      );
      // env 文件（base.env / brain .env）变更不自动杀 shell。
      // 模型在 shell 里执行 `source base.env` 或 `source .env` 即可生效，
      // 时机由模型控制，与 source ~/.bashrc 语义一致。
    }
  }

  /** 空闲 shell 立即 kill；正在执行命令的 shell 只 detach（不杀进程），让当前命令跑完后自然退出。 */
  private killAllShells(): void {
    for (const [key, s] of this.sharedShells) {
      if (s.pending) {
        this.sharedShells.delete(key); // detach: 下次 exec 重建新 shell，当前命令继续跑
      } else {
        try { s.process.kill("SIGTERM"); } catch {}
        this.sharedShells.delete(key);
      }
    }
  }

  // ─── Path helpers ───

  private logDirFor(brainId: string | undefined): string {
    const isSystem = !brainId;
    // 对于系统级终端，存在 bundle/.tmp 下
    if (isSystem) {
      return join(this.pathManager.bundle().root(), ".tmp", "terminals");
    }
    return join(this.pathManager.local(this.baseBrainId(brainId)).tmpDir(), "terminals");
  }

  private baseBrainId(brainId: string | undefined): string {
    if (!brainId) return ""; // "" = 系统终端专属 key，不与任何合法 brainId 冲突
    return brainId.split(":")[0];
  }

  private stateDirFor(brainId: string | undefined): string {
    return join(this.logDirFor(brainId), STATE_DIR);
  }

  private cwdFile(brainId: string | undefined): string {
    return join(this.stateDirFor(brainId), "cwd");
  }

  // ─── Brain env ───

  /**
   * 预构建系统级完整 shell env 并缓存（key = ''）
   */
  async loadSystemEnv(): Promise<void> {
    const fullEnv = await buildBrainShellEnv("", this.pathManager, this.unshareAvailable);
    this.brainEnvCache.set("", fullEnv);
  }

  /**
   * 预构建 brain 的完整 shell env 并缓存。
   *
   * 读取顺序（低→高优先级）：
   *   宿主机安全子集 < bundle/shared/env/base.env < brain .env
   *
   * useNamespace：namespace 沙箱启用时将 HOME 重映射到 BRAIN_DIR，
   * 并将 PYTHON_HOME/NODE_HOME/bin 注入 PATH。
   *
   * 调用方：Scheduler.initBrain()
   */
  async loadBrainEnv(brainId: string): Promise<void> {
    if (!brainId) return; // For system, call loadSystemEnv directly instead
    const base = this.baseBrainId(brainId);
    const fullEnv = await buildBrainShellEnv(base, this.pathManager, this.unshareAvailable);
    this.brainEnvCache.set(base, fullEnv);
  }

  // ─── Shell session management ───

  private resolveShellPath(brainEnv: Record<string, string>): string {
    const candidates = [
      brainEnv.SHELL || process.env.SHELL,
      "/usr/bin/bash",
      "/bin/bash",
      "bash",
    ].filter((v): v is string => Boolean(v));
    for (const c of candidates) {
      if (!c.includes("/")) return c;
      if (existsSync(c)) return c;
    }
    return "bash";
  }

  private resolveSessionCwd(initialCwd?: string): string {
    if (!initialCwd) return this.pathManager.root();
    try {
      if (statSync(initialCwd).isDirectory()) return initialCwd;
    } catch { /* stale path */ }
    return this.pathManager.root();
  }

  private createSession(baseBrainId: string, initialCwd?: string, initScript?: string): ShellSession {
    const isSystem = baseBrainId === ""; // 只有 brainId=undefined 时才是系统终端
    // brainEnvCache 已由 loadBrainEnv() 或 loadSystemEnv() 预构建好完整 env
    const cacheKey = baseBrainId; // "" → 系统 env，其余 → brain env
    const builtEnv   = this.brainEnvCache.get(cacheKey) ?? {};
    const shellPath  = this.resolveShellPath(builtEnv as Record<string, string>);
    const sessionCwd = this.resolveSessionCwd(initialCwd);

    // 若 unshare 可用，用 namespace 沙箱启动 shell，否则降级为普通 spawn
    const child = this.unshareAvailable
      ? spawn(
          "unshare",
          ["--mount", "--user", "--map-root-user", shellPath, "--norc", "--noprofile"],
          { cwd: sessionCwd, env: { ...builtEnv, PS1: "", PS2: "" }, stdio: ["pipe", "pipe", "pipe"] },
        )
      : spawn(shellPath, ["--norc", "--noprofile"], {
          cwd: sessionCwd,
          env: { ...builtEnv, PS1: "", PS2: "" },
          stdio: ["pipe", "pipe", "pipe"],
        });

    const session: ShellSession = {
      id: `s${++this.sessionCounter}-${Date.now()}`,
      baseBrainId,
      process: child,
      shellPath,
      pending: null,
      ready: Promise.resolve(),
      markReady: null,
      terminalIds: new Set(),
    };

    // Only stdout carries the completion markers; stderr is ignored at the session level.
    child.stdout?.on("data", (data: Buffer) => {
      if (!session.pending) return;
      session.pending.markerBuf += data.toString("utf-8");

      const idx = session.pending.markerBuf.indexOf(session.pending.marker);
      if (idx === -1) return;

      const after = session.pending.markerBuf.slice(idx + session.pending.marker.length).trim();
      const exitCode = parseInt(after, 10);

      const cb = session.pending.onComplete;
      session.pending = null;
      if (session.markReady) { session.markReady(); session.markReady = null; }
      cb(isNaN(exitCode) ? undefined : exitCode);
    });

    child.on("error", (err) => {
      session.spawnError = err instanceof Error ? err : new Error(String(err));
      if (session.pending) {
        const cb = session.pending.onComplete;
        session.pending = null;
        cb(undefined);
      }
      this.cleanupSession(cacheKey, session);
    });
    child.on("exit", (code) => {
      // Resolve any pending exec() that's still waiting for a marker.
      // This happens when the shell exits early (e.g. set -e cascades out of a command group).
      if (session.pending) {
        const cb = session.pending.onComplete;
        session.pending = null;
        cb(code ?? 1);
      }
      this.cleanupSession(cacheKey, session);
    });

    // namespace 内初始化挂载（/tmp 私有化、.ssh bind、动态 overlays）
    if (this.unshareAvailable) {
      try { child.stdin?.write(this.buildNsSetup(isSystem ? undefined : baseBrainId) + "\n"); } catch { /* ignore */ }
    }
    // Restore prior cwd when creating a replacement session
    if (initScript) {
      try { child.stdin?.write(initScript + "\n"); } catch { /* ignore */ }
    }

    this.sessions.set(session.id, session);
    return session;
  }

  private getSandboxMounts(): { target: string, upper: string }[] {
    const defaultMounts = [
      { target: "/usr/local", upper: "sys_usr_local" },
      { target: "/etc", upper: "sys_etc" },
      { target: "/var", upper: "sys_var" },
    ];
    const path = this.pathManager.bundle().sandboxMounts();
    if (!existsSync(path)) return defaultMounts;
    try {
      const data = JSON.parse(readFileSync(path, "utf-8"));
      if (Array.isArray(data.overlays)) {
        const packMounts = data.overlays.map((o: any) => ({ target: o.target as string, upper: (o.upper as string) || slugify(o.target as string) }));
        // pack overlays with same target override defaults; defaults always fill the gap
        const packTargets = new Set(packMounts.map((m: { target: string }) => m.target));
        return [...defaultMounts.filter(m => !packTargets.has(m.target)), ...packMounts];
      }
    } catch { /* parse error, return defaults */ }
    return defaultMounts;
  }

  /**
   * 生成在 namespace 内执行的 bash setup 脚本（通过 stdin 注入）。
   * 
   * SYSTEM Terminal: 针对整个 bundle (brainId='system')
   * USER Terminal: 针对特定 brain
   */
  private buildNsSetup(brainId: string | undefined): string {
    const isSystem = !brainId;
    const realHome = process.env.HOME ?? "";
    const overlaysDir = this.pathManager.bundle().sandboxOverlays();
    
    const lines: string[] = [];

    // 1. /tmp 共享化 (挂载到 bundle/shared/sandbox/tmp)
    const tmpDir = join(this.pathManager.bundle().sandboxDir(), "tmp");
    lines.push(
      `mkdir -p '${tmpDir}'`,
      `mount --bind '${tmpDir}' /tmp`
    );

    // 2. 动态加载 overlays — 必须在 HOME bind mount 之前完成！
    //    overlay upper/work 目录的绝对路径包含 $HOME 前缀；若先 bind HOME，
    //    namespace 内访问这些路径会被重定向到 .root_home，导致 overlay 数据写错地方。
    const mounts = this.getSandboxMounts();
    for (const m of mounts) {
      const olUpper = join(overlaysDir, m.upper, "upper");
      const olWork  = join(overlaysDir, m.upper, "work");
      lines.push(`mkdir -p '${m.target}' '${olUpper}' '${olWork}'`);

      // 在 upper 里预建 target 的一级子目录，避免 user namespace 中
      // overlayfs 对 root-owned 目录做 copy-up 时 EACCES。
      try {
        const subdirs = readdirSync(m.target, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => `'${join(olUpper, d.name)}'`);
        if (subdirs.length > 0) {
          lines.push(`mkdir -p ${subdirs.join(" ")}`);
        }
      } catch { /* target 在宿主机上可能不存在 */ }

      lines.push(
        `mount -t overlay overlay -o lowerdir='${m.target}',upperdir='${olUpper}',workdir='${olWork}' '${m.target}' 2>/dev/null || true`
      );
    }

    // 3. Home 映射 — 仅用户终端需要，系统终端不做 HOME bind
    //    系统终端（install-python/install-node/setup.sh）的日志路径、overlay 目录均在项目根下，
    //    若 bind $HOME → .root_home，这些绝对路径在 namespace 内会全部失效（循环引用）。
    if (!isSystem && realHome) {
      // User Terminal: 映射 brain 的 '.home' 为 '$HOME'
      const homeDir = this.pathManager.local(brainId).homeDir();
      lines.push(
        `mkdir -p '${homeDir}/.ssh'`,
        `mount --bind '${homeDir}' '${realHome}' 2>/dev/null || true`
      );
    }

    // 4. 无痛 sudo 包装 (因为 namespace 内部已经是 root，原系统 sudo 可能会因 setuid 报错)
    lines.push(
      `if [ ! -f /usr/local/bin/sudo ]; then`,
      `  echo '#!/bin/sh' > /usr/local/bin/sudo`,
      `  echo 'exec "$@"' >> /usr/local/bin/sudo`,
      `  chmod +x /usr/local/bin/sudo`,
      `fi`
    );

    return lines.join("\n");
  }

  private cleanupSession(baseBrainId: string, session: ShellSession): void {
    if (this.sharedShells.get(baseBrainId) === session) {
      this.sharedShells.delete(baseBrainId);
    }
    this.sessions.delete(session.id);
    if (session.markReady) { session.markReady(); session.markReady = null; }
  }

  /** Return the shared bash for this brain, creating one if needed.
   *  On timeout the session is detached (removed from the pool) but kept alive so it can finish
   *  writing the log and cwd state. A fresh session is created for subsequent commands. */
  private async getOrCreateSharedShell(brainId: string | undefined, initialCwd?: string): Promise<ShellSession> {
    const base = brainId ? this.baseBrainId(brainId) : "";
    const existing = this.sharedShells.get(base);
    if (existing && existing.process.exitCode === null) {
      return existing;
    }

    // Build an init script that restores the previous working directory if available
    let initScript: string | undefined;
    try {
      const savedCwd = (await readFile(this.cwdFile(brainId), "utf-8")).trim();
      if (savedCwd) {
        initScript = `cd ${shellQuote(savedCwd)} 2>/dev/null || true`;
      }
    } catch { /* no state to restore */ }

    const session = this.createSession(base, initialCwd, initScript);
    this.sharedShells.set(base, session);
    return session;
  }

  // ─── exec ───

  async exec(command: string, opts: ExecOpts): Promise<ExecResult> {
    const logDir  = this.logDirFor(opts.brainId);
    const stDir   = this.stateDirFor(opts.brainId);
    await mkdir(logDir, { recursive: true });
    await mkdir(stDir,  { recursive: true });

    const id      = `t${++this.terminalCounter}-${Date.now()}`;
    const descSlug = opts.description ? `-${slugify(opts.description)}` : "";
    const logFile = join(logDir, `${id}${descSlug}.txt`);
    const marker  = `__MCEND_${id}__`;
    const startedAt = Date.now();

    const cwdF = this.cwdFile(opts.brainId);

    const session = await this.getOrCreateSharedShell(opts.brainId, opts.initialCwd);

    // 原子地占住下一个 gate，再等待上一个完成。
    // 若先 await 再设 gate，两个并发的 exec() 都能通过旧 gate 并覆写 session.pending，
    // 导致先发出的命令永远收不到 onComplete 回调。
    const prevReady = session.ready;
    let readyResolve!: () => void;
    session.ready = new Promise<void>((r) => { readyResolve = r; });
    session.markReady = readyResolve;

    await prevReady;

    const instance: TerminalInstance = {
      id,
      sessionId: session.id,
      pid: session.process.pid ?? -1,
      command,
      cwd: opts.cwd ?? ".",
      brainId: opts.brainId,
      startedAt,
      logFile,
    };
    this.terminals.set(id, instance);
    session.terminalIds.add(id);

    if (session.spawnError || !session.process.stdin) {
      // 释放 gate，防止并发的 exec() 在 await prevReady 处永久挂起
      if (session.markReady) { session.markReady(); session.markReady = null; }
      const msg = `Shell unavailable (${session.shellPath}): ${session.spawnError?.message ?? "spawn failure"}`;
      instance.exitCode = 127;
      instance.elapsedMs = 0;
      await this.writeLog(instance, msg, true);
      return { terminalId: id, logFile, stdout: msg, exitCode: 127, backgrounded: false };
    }

    // Write log header immediately so the file exists and is readable before the command finishes
    await this.writeLog(instance, "", false);

    const wrapped = buildWrappedCommand({ command, opts, logFile, cwdF, marker, startedAt });

    return new Promise<ExecResult>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const effectiveTimeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      // If timeout <= 0, we don't set a timer. It will wait indefinitely.
      if (effectiveTimeout > 0) {
        timer = setTimeout(async () => {
          if (settled) return;
          settled = true;
          instance.backgrounded = true;

          const note = `\n[still running — backgrounded after ${effectiveTimeout}ms]\n`;
          await appendFile(logFile, note, "utf-8").catch(() => {});

          // Detach from the shared shell pool so subsequent execs get a fresh session.
          // The detached session continues running in the background; when done, it saves
          // the cwd to the state file so the new session can restore the working directory.
          // NOTE: env vars (export) set in this session will be lost in the new session.
          if (this.sharedShells.get(session.baseBrainId) === session) {
            this.sharedShells.delete(session.baseBrainId);
          }

          resolve({
            terminalId: id,
            logFile,
            stdout: note.trim(),
            backgrounded: true,
            hint: `Command running in background. Poll log: ${logFile}`,
          });
        }, effectiveTimeout);
      }

      session.pending = {
        marker,
        markerBuf: "",
        onComplete: async (exitCode) => {
          if (timer) clearTimeout(timer);
          session.terminalIds.delete(id);
          instance.exitCode  = exitCode;
          instance.elapsedMs = Date.now() - startedAt;

          if (!settled) {
            settled = true;
            const body = await readLogBody(logFile);
            resolve({ terminalId: id, logFile, stdout: body, exitCode, backgrounded: false });
          }
        },
      };

      try {
        session.process.stdin!.write(wrapped);
      } catch (err) {
        if (timer) clearTimeout(timer);
        session.terminalIds.delete(id);
        session.pending = null;
        if (session.markReady) { session.markReady(); session.markReady = null; }
        const msg = `Shell write failed: ${err instanceof Error ? err.message : String(err)}`;
        instance.exitCode = 127;
        instance.elapsedMs = Date.now() - startedAt;
        void this.writeLog(instance, msg, true);
        if (!settled) {
          settled = true;
          resolve({ terminalId: id, logFile, stdout: msg, exitCode: 127, backgrounded: false });
        }
      }
    });
  }

  // ─── TerminalManagerAPI implementation ───

  get(id: string): TerminalInstance | undefined {
    return this.terminals.get(id);
  }

  list(filter?: { brainId?: string; status?: string }): TerminalInstance[] {
    const result: TerminalInstance[] = [];
    for (const [, t] of this.terminals) {
      if (filter?.brainId && t.brainId !== filter.brainId) continue;
      if (filter?.status === "running" && t.exitCode !== undefined) continue;
      if (filter?.status === "done"    && t.exitCode === undefined) continue;
      result.push(t);
    }
    return result;
  }

  kill(id: string): boolean {
    const session = [...this.sessions.values()].find((s) => s.terminalIds.has(id));
    if (!session || session.process.exitCode !== null) return false;
    // Send SIGINT to the process group to interrupt the foreground job in the shared shell
    try {
      process.kill(-session.process.pid!, "SIGINT");
      return true;
    } catch {
      try { session.process.stdin!.write("\x03"); return true; } catch { return false; }
    }
  }

  cleanup(maxAge?: number): void {
    if (maxAge === 0) {
      for (const [, session] of this.sessions) {
        try { session.process.kill("SIGTERM"); } catch {}
      }
      this.sharedShells.clear();
      this.sessions.clear();
      // 重置初始化状态，使 ensureReady() → init() 可重新执行（例如 loadPackToBundle 后）
      this._ready = false;
      this.initPromise = null;
      this.brainEnvCache.clear();
      // 释放旧的 FSWatcher 注册，防止 _doInit() 重入时重复注册
      for (const d of this.watcherDisposables) d.dispose();
      this.watcherDisposables = [];
    }
    const cutoff = Date.now() - (maxAge ?? 3_600_000);
    for (const [id, t] of this.terminals) {
      if (t.exitCode !== undefined && t.startedAt < cutoff) {
        this.terminals.delete(id);
        unlink(t.logFile).catch(() => {});
      }
    }
  }

  // ─── Log helpers ───

  private async writeLog(instance: TerminalInstance, body: string, finished = false): Promise<void> {
    const header = [
      "---",
      `id: ${instance.id}`,
      `session_id: ${instance.sessionId}`,
      `pid: ${instance.pid}`,
      `cwd: ${instance.cwd}`,
      `command: ${instance.command}`,
      `brain: ${instance.brainId ?? "system"}`,
      `started_at: ${new Date(instance.startedAt).toISOString()}`,
      "---",
      "",
    ].join("\n");

    if (finished) {
      const footer = [
        "",
        "---",
        `exit_code: ${instance.exitCode ?? "unknown"}`,
        `elapsed_ms: ${instance.elapsedMs ?? Date.now() - instance.startedAt}`,
        "---",
      ].join("\n");
      await writeFile(instance.logFile, header + body + footer).catch(() => {});
    } else {
      // Write only header; bash will append the body + footer directly
      await writeFile(instance.logFile, header).catch(() => {});
    }
  }
}

// ─── Helpers ───

interface WrapOpts {
  command: string;
  opts: ExecOpts;
  logFile: string;
  cwdF: string;
  marker: string;
  startedAt: number;
}

/** Wrap a user command so that:
 *  - stdout + stderr stream directly into the log file (real-time, no Node buffering)
 *  - cwd is persisted after completion for new-session restore
 *  - a unique marker is echoed to bash stdout so Node knows when the command finished */
function buildWrappedCommand({ command, opts, logFile, cwdF, marker, startedAt }: WrapOpts): string {
  let cmd = command;
  if (opts.cwd) cmd = `cd ${shellQuote(opts.cwd)} && { ${cmd} ; }`;
  if (opts.env) {
    const exports = Object.entries(opts.env)
      .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
      .join("; ");
    cmd = `${exports}; ${cmd}`;
  }

  return [
    // Use a subshell ( ) instead of a command group { } so that `set -e` inside the
    // command cannot cascade into the outer long-lived bash session and kill it early.
    `( ${cmd} ) >> ${shellQuote(logFile)} 2>&1`,
    `__mc_rc=$?`,
    `pwd > ${shellQuote(cwdF)} 2>/dev/null || true`,
    `printf '\\n---\\nexit_code: '%s'\\nelapsed_ms: '%s'\\n---\\n'` +
      ` "$__mc_rc" "$(($(date +%s%3N) - ${startedAt}))" >> ${shellQuote(logFile)} 2>/dev/null || true`,
    `echo ""`,
    `echo "${marker} $__mc_rc"`,
  ].join("\n") + "\n";
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Convert a description string to a safe filename slug (max 32 chars). */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 32);
}

/** Read the log body (everything after the header) for inline return to the caller. */
async function readLogBody(logFile: string): Promise<string> {
  try {
    const raw = await readFile(logFile, "utf-8");
    // Skip the 9-line header block (--- ... ---\n\n)
    const headerEnd = raw.indexOf("\n---\n", raw.indexOf("---\n") + 4);
    const body = headerEnd !== -1 ? raw.slice(headerEnd + 5) : raw;
    return body.slice(0, MAX_STDOUT_CAPTURE);
  } catch {
    return "";
  }
}
