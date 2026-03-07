import { spawn, type ChildProcess } from "node:child_process";
import { writeFile, readFile, mkdir, unlink } from "node:fs/promises";
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

let terminalManagerInstance: TerminalManager | null = null;

interface PendingCommand {
  marker: string;
  chunks: string[];
  onComplete: (output: string, exitCode: number | undefined) => void;
}

interface ShellSession {
  id: string;
  baseBrainId: string;
  process: ChildProcess;
  pending: PendingCommand | null;
  ready: Promise<void>;
  markReady: (() => void) | null;
  terminalIds: Set<string>;
  detached: boolean;
}

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

export class TerminalManager implements TerminalManagerAPI {
  private terminals = new Map<string, TerminalInstance>();
  private sharedShells = new Map<string, ShellSession>();
  private terminalSessions = new Map<string, ShellSession>();
  private sessions = new Map<string, ShellSession>();
  private terminalCounter = 0;
  private sessionCounter = 0;
  private brainEnvCache = new Map<string, Record<string, string>>();

  constructor(private pathManager: PathManagerAPI) {}

  private logDirFor(brainId: string): string {
    const base = brainId.split(":")[0];
    return join(this.pathManager.brainDir(base), "workspace", "terminate");
  }

  private baseBrainId(brainId: string): string {
    return brainId.split(":")[0];
  }

  async loadBrainEnv(brainId: string): Promise<void> {
    const base = this.baseBrainId(brainId);
    try {
      const raw = await readFile(
        join(this.pathManager.brainDir(base), "brain.json"),
        "utf-8",
      );
      const config: BrainJson = JSON.parse(raw);
      if (config.env) {
        this.brainEnvCache.set(base, config.env);
      }
    } catch {
      // no env to load
    }
  }

  private createSession(baseBrainId: string, initialCwd?: string): ShellSession {
    const brainEnv = this.brainEnvCache.get(baseBrainId) ?? {};
    const child = spawn("bash", ["--norc", "--noprofile"], {
      cwd: initialCwd ?? this.pathManager.root(),
      env: { ...process.env, ...brainEnv, PS1: "", PS2: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const session: ShellSession = {
      id: `s${++this.sessionCounter}-${Date.now()}`,
      baseBrainId,
      process: child,
      pending: null,
      ready: Promise.resolve(),
      markReady: null,
      terminalIds: new Set(),
      detached: false,
    };

    const handleData = (data: Buffer) => {
      if (!session.pending) return;
      const text = data.toString("utf-8");
      session.pending.chunks.push(text);

      const combined = session.pending.chunks.join("");
      const idx = combined.indexOf(session.pending.marker);
      if (idx === -1) return;

      const output = combined.slice(0, idx).trimEnd();
      const rest = combined.slice(idx + session.pending.marker.length).trim();
      const exitCode = parseInt(rest, 10);

      const cb = session.pending.onComplete;
      session.pending = null;

      if (session.markReady) {
        session.markReady();
        session.markReady = null;
      }

      cb(output, isNaN(exitCode) ? undefined : exitCode);
    };

    child.stdout!.on("data", handleData);
    child.stderr!.on("data", handleData);

    child.on("exit", () => {
      if (this.sharedShells.get(baseBrainId) === session) {
        this.sharedShells.delete(baseBrainId);
      }
      this.sessions.delete(session.id);
      for (const terminalId of session.terminalIds) {
        if (this.terminalSessions.get(terminalId) === session) {
          this.terminalSessions.delete(terminalId);
        }
      }
      if (session.markReady) {
        session.markReady();
        session.markReady = null;
      }
    });

    this.sessions.set(session.id, session);
    return session;
  }

  private getOrCreateSharedShell(brainId: string, initialCwd?: string): ShellSession {
    const base = this.baseBrainId(brainId);
    const existing = this.sharedShells.get(base);
    if (existing && existing.process.exitCode === null) {
      return existing;
    }
    const session = this.createSession(base, initialCwd);
    this.sharedShells.set(base, session);
    return session;
  }

  private detachSharedShell(brainId: string, session: ShellSession): void {
    const base = this.baseBrainId(brainId);
    if (this.sharedShells.get(base) === session) {
      session.detached = true;
      this.sharedShells.delete(base);
    }
  }

  async exec(command: string, opts: ExecOpts): Promise<ExecResult> {
    const logDir = this.logDirFor(opts.brainId);
    await mkdir(logDir, { recursive: true });

    const id = `t${++this.terminalCounter}-${Date.now()}`;
    const logFile = join(logDir, `${id}.txt`);
    const startedAt = Date.now();
    const marker = `__MCEND_${id}__`;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const session = this.getOrCreateSharedShell(opts.brainId, opts.initialCwd);

    // Serialize: wait for previous command to finish if shell is still occupied
    await session.ready;

    let cmd = command;
    if (opts.cwd) {
      cmd = `cd ${shellQuote(opts.cwd)} && ${cmd}`;
    }
    if (opts.env) {
      const exports = Object.entries(opts.env)
        .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
        .join("; ");
      cmd = `${exports}; ${cmd}`;
    }

    // Capture exit code before marker echo so it reflects the real command
    const wrapped = `{ ${cmd} ; } 2>&1; __mc_rc=$?; echo ""; echo "${marker} $__mc_rc"\n`;

    const instance: TerminalInstance = {
      id,
      sessionId: session.id,
      pid: session.process.pid!,
      command,
      cwd: opts.cwd ?? ".",
      brainId: opts.brainId,
      startedAt,
      logFile,
    };
    this.terminals.set(id, instance);
    this.terminalSessions.set(id, session);
    session.terminalIds.add(id);

    // Gate for the next command
    let readyResolve!: () => void;
    session.ready = new Promise<void>((r) => { readyResolve = r; });
    session.markReady = readyResolve;

    return new Promise<ExecResult>((resolve) => {
      let settled = false;

      session.pending = {
        marker,
        chunks: [],
        onComplete: (output, exitCode) => {
          clearTimeout(timer);
          this.terminalSessions.delete(id);
          session.terminalIds.delete(id);
          instance.exitCode = exitCode;
          instance.elapsedMs = Date.now() - startedAt;
          this.writeLog(instance, output, true);

          if (!settled) {
            settled = true;
            resolve({
              terminalId: id,
              logFile,
              stdout: output.slice(0, MAX_STDOUT_CAPTURE),
              exitCode,
              backgrounded: false,
            });
          }
        },
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        instance.backgrounded = true;
        this.detachSharedShell(opts.brainId, session);
        const output = session.pending?.chunks.join("") ?? "";
        this.writeLog(instance, output);
        resolve({
          terminalId: id,
          logFile,
          stdout: output.slice(0, MAX_STDOUT_CAPTURE),
          backgrounded: true,
          hint: `Command still running (pid ${session.process.pid}). Read the log file: ${logFile}`,
        });
        // pending stays set — when marker arrives it will update instance and ungate next command
      }, timeoutMs);

      session.process.stdin!.write(wrapped);
    });
  }

  get(id: string): TerminalInstance | undefined {
    return this.terminals.get(id);
  }

  list(filter?: { brainId?: string; status?: string }): TerminalInstance[] {
    const result: TerminalInstance[] = [];
    for (const [, t] of this.terminals) {
      if (filter?.brainId && t.brainId !== filter.brainId) continue;
      if (filter?.status === "running" && t.exitCode !== undefined) continue;
      if (filter?.status === "done" && t.exitCode === undefined) continue;
      result.push(t);
    }
    return result;
  }

  kill(id: string): boolean {
    const session = this.terminalSessions.get(id);
    if (!session || session.process.exitCode !== null) return false;
    try {
      // Send Ctrl+C to interrupt the current command without killing the shell
      session.process.stdin!.write("\x03");
      return true;
    } catch {
      return false;
    }
  }

  cleanup(maxAge?: number): void {
    if (maxAge === 0) {
      for (const [, session] of this.sessions) {
        try { session.process.kill("SIGTERM"); } catch {}
      }
      this.sharedShells.clear();
      this.terminalSessions.clear();
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

  private async writeLog(
    instance: TerminalInstance,
    output: string,
    finished = false,
  ): Promise<void> {
    const header = [
      "---",
      `id: ${instance.id}`,
      `session_id: ${instance.sessionId}`,
      `pid: ${instance.pid}`,
      `cwd: ${instance.cwd}`,
      `command: ${instance.command}`,
      `brain: ${instance.brainId}`,
      `backgrounded: ${instance.backgrounded ? "true" : "false"}`,
      `started_at: ${new Date(instance.startedAt).toISOString()}`,
      "---",
      "",
    ].join("\n");

    let footer = "";
    if (finished) {
      footer = [
        "",
        "---",
        `exit_code: ${instance.exitCode ?? "unknown"}`,
        `elapsed_ms: ${instance.elapsedMs ?? Date.now() - instance.startedAt}`,
        "---",
      ].join("\n");
    }

    await writeFile(instance.logFile, header + output + footer).catch(() => {});
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
