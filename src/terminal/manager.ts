import { spawn, type ChildProcess } from "node:child_process";
import { writeFile, readFile, mkdir, unlink } from "node:fs/promises";
import { readFileSync } from "node:fs";
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

interface PendingCommand {
  marker: string;
  chunks: string[];
  onComplete: (output: string, exitCode: number | undefined) => void;
}

interface ShellSession {
  process: ChildProcess;
  pending: PendingCommand | null;
  ready: Promise<void>;
  markReady: (() => void) | null;
}

export class TerminalManager implements TerminalManagerAPI {
  private terminals = new Map<string, TerminalInstance>();
  private shells = new Map<string, ShellSession>();
  private counter = 0;
  private brainEnvCache = new Map<string, Record<string, string>>();

  constructor(private pathManager: PathManagerAPI) {}

  private logDirFor(brainId: string): string {
    const base = brainId.split(":")[0];
    return join(this.pathManager.brainDir(base), "workspace", "terminals");
  }

  async loadBrainEnv(brainId: string): Promise<void> {
    try {
      const raw = await readFile(
        join(this.pathManager.brainDir(brainId), "brain.json"),
        "utf-8",
      );
      const config: BrainJson = JSON.parse(raw);
      if (config.env) {
        this.brainEnvCache.set(brainId, config.env);
      }
    } catch {
      // no env to load
    }
  }

  private getOrCreateShell(brainId: string): ShellSession {
    const base = brainId.split(":")[0];
    const existing = this.shells.get(base);
    if (existing && existing.process.exitCode === null) {
      return existing;
    }

    const brainEnv = this.brainEnvCache.get(base) ?? {};
    const child = spawn("bash", ["--norc", "--noprofile"], {
      cwd: this.pathManager.root(),
      env: { ...process.env, ...brainEnv, PS1: "", PS2: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const session: ShellSession = {
      process: child,
      pending: null,
      ready: Promise.resolve(),
      markReady: null,
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
      this.shells.delete(base);
      if (session.markReady) {
        session.markReady();
        session.markReady = null;
      }
    });

    this.shells.set(base, session);
    return session;
  }

  async exec(command: string, opts: ExecOpts): Promise<ExecResult> {
    const logDir = this.logDirFor(opts.brainId);
    await mkdir(logDir, { recursive: true });

    const id = `t${++this.counter}-${Date.now()}`;
    const logFile = join(logDir, `${id}.txt`);
    const startedAt = Date.now();
    const marker = `__MCEND_${id}__`;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const session = this.getOrCreateShell(opts.brainId);

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
      pid: session.process.pid!,
      command,
      cwd: opts.cwd ?? ".",
      brainId: opts.brainId,
      startedAt,
      logFile,
    };
    this.terminals.set(id, instance);

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
          instance.exitCode = exitCode;
          instance.elapsedMs = Date.now() - startedAt;
          this.writeLog(instance, output, true);

          if (!settled) {
            settled = true;
            resolve({
              terminalId: id,
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
        const output = session.pending?.chunks.join("") ?? "";
        this.writeLog(instance, output);
        resolve({
          terminalId: id,
          stdout: output.slice(0, MAX_STDOUT_CAPTURE),
          backgrounded: true,
          hint: `Command still running (pid ${session.process.pid}). Use readOutput("${id}") to check later.`,
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
    const t = this.terminals.get(id);
    if (!t) return false;
    const base = t.brainId.split(":")[0];
    const session = this.shells.get(base);
    if (!session || session.process.exitCode !== null) return false;
    try {
      // Send Ctrl+C to interrupt the current command without killing the shell
      session.process.stdin!.write("\x03");
      return true;
    } catch {
      return false;
    }
  }

  readOutput(id: string, opts?: { tail?: number }): string {
    const t = this.terminals.get(id);
    if (!t) return `Terminal ${id} not found`;
    try {
      const content = readFileSync(t.logFile, "utf-8");
      if (opts?.tail) {
        const lines = content.split("\n");
        return lines.slice(-opts.tail).join("\n");
      }
      return content;
    } catch {
      return `Log file not available for terminal ${id}`;
    }
  }

  cleanup(maxAge?: number): void {
    if (maxAge === 0) {
      for (const [, session] of this.shells) {
        try { session.process.kill("SIGTERM"); } catch {}
      }
      this.shells.clear();
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
      `pid: ${instance.pid}`,
      `cwd: ${instance.cwd}`,
      `command: ${instance.command}`,
      `brain: ${instance.brainId}`,
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
