import { spawn, type ChildProcess } from "node:child_process";
import { writeFile, readFile, readdir, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  TerminalManagerAPI,
  TerminalInstance,
  ExecOpts,
  ExecResult,
  PathManagerAPI,
} from "../core/types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_STDOUT_CAPTURE = 512_000; // 512 KB inline cap

export class TerminalManager implements TerminalManagerAPI {
  private terminals = new Map<string, TerminalInstance & { process?: ChildProcess }>();
  private logDir: string;
  private counter = 0;

  constructor(private pathManager: PathManagerAPI) {
    this.logDir = pathManager.dir("terminals");
  }

  async exec(command: string, opts: ExecOpts): Promise<ExecResult> {
    await mkdir(this.logDir, { recursive: true });

    const id = `t${++this.counter}-${Date.now()}`;
    const cwd = opts.cwd ?? this.pathManager.root();
    const logFile = join(this.logDir, `${id}.txt`);
    const startedAt = Date.now();

    const env = { ...process.env, ...opts.env };
    const child = spawn("bash", ["-c", command], { cwd, env, stdio: "pipe" });

    const instance: TerminalInstance & { process?: ChildProcess } = {
      id,
      pid: child.pid!,
      command,
      cwd,
      brainId: opts.brainId,
      startedAt,
      logFile,
      process: child,
    };
    this.terminals.set(id, instance);

    const chunks: Buffer[] = [];
    let totalBytes = 0;

    child.stdout?.on("data", (data: Buffer) => {
      if (totalBytes < MAX_STDOUT_CAPTURE) {
        chunks.push(data);
        totalBytes += data.length;
      }
    });
    child.stderr?.on("data", (data: Buffer) => {
      if (totalBytes < MAX_STDOUT_CAPTURE) {
        chunks.push(data);
        totalBytes += data.length;
      }
    });

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise<ExecResult>((resolve) => {
      let settled = false;
      let backgrounded = false;

      const timer = setTimeout(() => {
        if (settled) return;
        backgrounded = true;
        settled = true;
        this.writeLog(instance, Buffer.concat(chunks).toString("utf-8"));
        resolve({
          terminalId: id,
          stdout: Buffer.concat(chunks).toString("utf-8").slice(0, MAX_STDOUT_CAPTURE),
          backgrounded: true,
          hint: `Command still running (pid ${child.pid}). Use readOutput("${id}") to check later.`,
        });
      }, timeoutMs);

      child.on("close", (code) => {
        clearTimeout(timer);
        instance.exitCode = code ?? undefined;
        instance.elapsedMs = Date.now() - startedAt;
        delete instance.process;

        const stdout = Buffer.concat(chunks).toString("utf-8");
        this.writeLog(instance, stdout, true);

        if (settled) return;
        settled = true;
        resolve({
          terminalId: id,
          stdout: stdout.slice(0, MAX_STDOUT_CAPTURE),
          exitCode: code ?? undefined,
          backgrounded: false,
        });
      });
    });
  }

  get(id: string): TerminalInstance | undefined {
    const t = this.terminals.get(id);
    if (!t) return undefined;
    const { process: _p, ...rest } = t;
    return rest;
  }

  list(filter?: { brainId?: string; status?: string }): TerminalInstance[] {
    const result: TerminalInstance[] = [];
    for (const [, t] of this.terminals) {
      if (filter?.brainId && t.brainId !== filter.brainId) continue;
      if (filter?.status === "running" && t.exitCode !== undefined) continue;
      if (filter?.status === "done" && t.exitCode === undefined) continue;
      const { process: _p, ...rest } = t;
      result.push(rest);
    }
    return result;
  }

  kill(id: string): boolean {
    const t = this.terminals.get(id);
    if (!t?.process) return false;
    try {
      t.process.kill("SIGTERM");
      return true;
    } catch {
      return false;
    }
  }

  readOutput(id: string, opts?: { tail?: number }): string {
    const t = this.terminals.get(id);
    if (!t) return `Terminal ${id} not found`;
    try {
      const fs = require("node:fs");
      const content: string = fs.readFileSync(t.logFile, "utf-8");
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
