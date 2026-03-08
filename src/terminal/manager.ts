import { spawn, type ChildProcess } from "node:child_process";
import { writeFile, appendFile, readFile, mkdir, unlink } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  TerminalManagerAPI,
  TerminalInstance,
  ExecOpts,
  ExecResult,
  PathManagerAPI,
  BrainJson,
} from "../core/types.js";

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
  private brainEnvCache   = new Map<string, Record<string, string>>();

  constructor(private pathManager: PathManagerAPI) {}

  // ─── Path helpers ───

  private logDirFor(brainId: string): string {
    return join(this.pathManager.brainDir(this.baseBrainId(brainId)), "workspace", "terminate");
  }

  private baseBrainId(brainId: string): string {
    return brainId.split(":")[0];
  }

  private stateDirFor(brainId: string): string {
    return join(this.logDirFor(brainId), STATE_DIR);
  }

  private cwdFile(brainId: string): string {
    return join(this.stateDirFor(brainId), "cwd");
  }

  // ─── Brain env ───

  async loadBrainEnv(brainId: string): Promise<void> {
    const base = this.baseBrainId(brainId);
    try {
      const raw = await readFile(join(this.pathManager.brainDir(base), "brain.json"), "utf-8");
      const config: BrainJson = JSON.parse(raw);
      if (config.env) this.brainEnvCache.set(base, config.env);
    } catch { /* no env to load */ }
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
    const brainEnv  = this.brainEnvCache.get(baseBrainId) ?? {};
    const shellPath = this.resolveShellPath(brainEnv);
    const sessionCwd = this.resolveSessionCwd(initialCwd);

    const child = spawn(shellPath, ["--norc", "--noprofile"], {
      cwd: sessionCwd,
      env: { ...process.env, ...brainEnv, PS1: "", PS2: "" },
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
      this.cleanupSession(baseBrainId, session);
    });
    child.on("exit", () => this.cleanupSession(baseBrainId, session));

    // Restore prior cwd when creating a replacement session
    if (initScript) {
      try { child.stdin?.write(initScript + "\n"); } catch { /* ignore */ }
    }

    this.sessions.set(session.id, session);
    return session;
  }

  /** Remove a session from the shared pool without killing it.
   *  The session keeps running and will write its final cwd to the state file on completion. */
  private detachSharedShell(brainId: string, session: ShellSession): void {
    const base = this.baseBrainId(brainId);
    if (this.sharedShells.get(base) === session) {
      this.sharedShells.delete(base);
    }
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
  private async getOrCreateSharedShell(brainId: string, initialCwd?: string): Promise<ShellSession> {
    const base = this.baseBrainId(brainId);
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
    await session.ready;

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
      const msg = `Shell unavailable (${session.shellPath}): ${session.spawnError?.message ?? "spawn failure"}`;
      instance.exitCode = 127;
      instance.elapsedMs = 0;
      await this.writeLog(instance, msg, true);
      return { terminalId: id, logFile, stdout: msg, exitCode: 127, backgrounded: false };
    }

    // Write log header immediately so the file exists and is readable before the command finishes
    await this.writeLog(instance, "", false);

    const wrapped = buildWrappedCommand({ command, opts, logFile, cwdF, marker, startedAt });

    // Gate: next command waits for this one to complete
    let readyResolve!: () => void;
    session.ready = new Promise<void>((r) => { readyResolve = r; });
    session.markReady = readyResolve;

    return new Promise<ExecResult>((resolve) => {
      let settled = false;

      const effectiveTimeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const timer = setTimeout(async () => {
        if (settled) return;
        settled = true;
        instance.backgrounded = true;

        const note = `\n[still running — backgrounded after ${effectiveTimeout}ms]\n`;
        await appendFile(logFile, note, "utf-8").catch(() => {});

        // Detach from the shared shell pool so subsequent execs get a fresh session.
        // The detached session continues running in the background; when done, it saves
        // the cwd to the state file so the new session can restore the working directory.
        // NOTE: env vars (export) set in this session will be lost in the new session.
        this.detachSharedShell(opts.brainId, session);

        resolve({
          terminalId: id,
          logFile,
          stdout: note.trim(),
          backgrounded: true,
          hint: `Command running in background. Poll log: ${logFile}`,
        });
      }, effectiveTimeout);

      session.pending = {
        marker,
        markerBuf: "",
        onComplete: async (exitCode) => {
          clearTimeout(timer);
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
        clearTimeout(timer);
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
      `brain: ${instance.brainId}`,
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
    `{ ${cmd} ; } >> ${shellQuote(logFile)} 2>&1`,
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
