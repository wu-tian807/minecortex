import { createWriteStream, statSync, renameSync, existsSync, mkdirSync } from "node:fs";
import type { WriteStream } from "node:fs";
import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { formatWithOptions } from "node:util";
import type { PathManagerAPI } from "./types.js";

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

const LEVEL_LABELS: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: "DEBUG",
  [LogLevel.INFO]: "INFO ",
  [LogLevel.WARN]: "WARN ",
  [LogLevel.ERROR]: "ERROR",
};

const MAX_FILE_SIZE = 50 * 1024 * 1024;
const MAX_ROTATIONS = 5;
type ConsoleMethod = "debug" | "log" | "info" | "warn" | "error";
type ConsoleFn = (...args: unknown[]) => void;
export interface LogContext {
  brainId: string;
  turn: number;
}

const CONSOLE_METHODS: ConsoleMethod[] = ["debug", "log", "info", "warn", "error"];
const DEFAULT_LOG_CONTEXT: LogContext = { brainId: "scheduler", turn: 0 };
const logContextStorage = new AsyncLocalStorage<LogContext>();

const consoleBridgeState: {
  installed: boolean;
  logger: Logger | null;
  defaultContext: LogContext;
  originals: Partial<Record<ConsoleMethod, ConsoleFn>>;
} = {
  installed: false,
  logger: null,
  defaultContext: DEFAULT_LOG_CONTEXT,
  originals: {},
};

function ts(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

function formatConsoleArgs(args: unknown[]): string {
  if (args.length === 0) return "";
  return formatWithOptions({ colors: false, depth: 6 }, ...args);
}

function forwardToOriginalConsole(method: ConsoleMethod, args: unknown[]): void {
  consoleBridgeState.originals[method]?.(...args);
}

export function getLogContext(): LogContext {
  return logContextStorage.getStore() ?? consoleBridgeState.defaultContext;
}

export function runWithLogContext<T>(
  ctx: Partial<LogContext> & Pick<LogContext, "brainId">,
  fn: () => T,
): T {
  const parent = getLogContext();
  return logContextStorage.run({
    brainId: ctx.brainId,
    turn: ctx.turn ?? parent.turn,
  }, fn);
}

export function bindLogContext<TArgs extends unknown[], TResult>(
  ctx: Partial<LogContext> & Pick<LogContext, "brainId">,
  fn: (...args: TArgs) => TResult,
): (...args: TArgs) => TResult {
  return (...args: TArgs) => runWithLogContext(ctx, () => fn(...args));
}

export function installConsoleBridge(): void {
  if (consoleBridgeState.installed) return;

  for (const method of CONSOLE_METHODS) {
    consoleBridgeState.originals[method] = console[method].bind(console) as ConsoleFn;
    console[method] = ((...args: unknown[]) => {
      const logger = consoleBridgeState.logger;
      if (!logger) {
        forwardToOriginalConsole(method, args);
        return;
      }

      const msg = formatConsoleArgs(args);
      const { brainId, turn } = getLogContext();

      switch (method) {
        case "debug":
          logger.debug(brainId, turn, msg);
          break;
        case "log":
        case "info":
          logger.info(brainId, turn, msg);
          break;
        case "warn":
          logger.warn(brainId, turn, msg);
          break;
        case "error":
          logger.error(brainId, turn, msg);
          break;
      }
    }) as ConsoleFn;
  }

  consoleBridgeState.installed = true;
}

export function attachConsoleLogger(logger: Logger, opts?: { brainId?: string; turn?: number }): void {
  installConsoleBridge();
  consoleBridgeState.logger = logger;
  consoleBridgeState.defaultContext = {
    brainId: opts?.brainId ?? DEFAULT_LOG_CONTEXT.brainId,
    turn: opts?.turn ?? DEFAULT_LOG_CONTEXT.turn,
  };
}

export function detachConsoleLogger(logger?: Logger): void {
  if (!logger || consoleBridgeState.logger === logger) {
    consoleBridgeState.logger = null;
  }
}

/** Per-brain file logger with latest.log (INFO+) + debug.log (all levels) */
class BrainFileLogger {
  private debugStream: WriteStream;
  private latestStream: WriteStream;
  private debugBytes = 0;
  private debugPath: string;
  private queue: string[] = [];
  private writing = false;
  private closed = false;

  constructor(logDir: string) {
    mkdirSync(logDir, { recursive: true });
    this.debugPath = join(logDir, "debug.log");
    this.debugStream = createWriteStream(this.debugPath, { flags: "a" });
    this.latestStream = createWriteStream(join(logDir, "latest.log"), { flags: "w" });
    try { this.debugBytes = statSync(this.debugPath).size; } catch { this.debugBytes = 0; }
  }

  write(line: string, isImportant: boolean): void {
    this.debugStream.write(line);
    this.debugBytes += Buffer.byteLength(line);
    if (this.debugBytes >= MAX_FILE_SIZE) this.rotateDebug();
    if (isImportant) this.latestStream.write(line);
  }

  private rotateDebug(): void {
    this.debugStream.end();
    for (let i = MAX_ROTATIONS - 1; i >= 1; i--) {
      const from = `${this.debugPath}.${i}`;
      const to = `${this.debugPath}.${i + 1}`;
      if (existsSync(from)) renameSync(from, to);
    }
    if (existsSync(this.debugPath)) renameSync(this.debugPath, `${this.debugPath}.1`);
    this.debugStream = createWriteStream(this.debugPath, { flags: "a" });
    this.debugBytes = 0;
  }

  close(): void {
    this.debugStream.end();
    this.latestStream.end();
  }
}

export class Logger {
  private pathManager: PathManagerAPI | null;
  private brainLoggers = new Map<string, BrainFileLogger>();
  private logsDir: string;
  private globalDebugStream: WriteStream;
  private globalDebugPath: string;
  private globalDebugBytes = 0;
  private closed = false;
  public level: LogLevel = LogLevel.DEBUG;

  constructor(pathManager: PathManagerAPI) {
    this.pathManager = pathManager;
    this.logsDir = pathManager.logsDir();
    mkdirSync(this.logsDir, { recursive: true });
    this.globalDebugPath = join(this.logsDir, "debug.log");
    this.globalDebugStream = createWriteStream(this.globalDebugPath, { flags: "a" });
    try { this.globalDebugBytes = statSync(this.globalDebugPath).size; } catch { this.globalDebugBytes = 0; }
    attachConsoleLogger(this);
  }

  debug(brainId: string, turn: number, msg: string, err?: Error): void {
    this.write(LogLevel.DEBUG, brainId, turn, msg, err);
  }

  info(brainId: string, turn: number, msg: string, err?: Error): void {
    this.write(LogLevel.INFO, brainId, turn, msg, err);
  }

  warn(brainId: string, turn: number, msg: string, err?: Error): void {
    this.write(LogLevel.WARN, brainId, turn, msg, err);
  }

  error(brainId: string, turn: number, msg: string, err?: Error): void {
    this.write(LogLevel.ERROR, brainId, turn, msg, err);
  }

  private write(level: LogLevel, brainId: string, turn: number, msg: string, err?: Error): void {
    if (level < this.level) return;

    const line = this.formatLine(level, brainId, turn, msg, err);
    this.writeLine(line, level, brainId);
  }

  private formatLine(level: LogLevel, brainId: string, turn: number, msg: string, err?: Error): string {
    let line = `[${ts()}] [${LEVEL_LABELS[level]}] [${brainId}#${turn}] ${msg}`;
    if (err) line += `\n  ${err.stack ?? err.message}`;
    return line + "\n";
  }

  private writeLine(line: string, level: LogLevel, brainId: string): void {
    process.stderr.write(line);
    this.writeGlobal(line);
    this.writeBrain(line, level, brainId);
  }

  private writeGlobal(line: string): void {
    this.globalDebugStream.write(line);
    this.globalDebugBytes += Buffer.byteLength(line);
    if (this.globalDebugBytes >= MAX_FILE_SIZE) this.rotateGlobal();
  }

  private writeBrain(line: string, level: LogLevel, brainId: string): void {
    const baseBrainId = brainId.split(":")[0];
    if (!baseBrainId || baseBrainId === "scheduler" || !this.pathManager) return;
    const logger = this.getOrCreateBrainLogger(baseBrainId);
    logger.write(line, level >= LogLevel.INFO);
  }

  private getOrCreateBrainLogger(brainId: string): BrainFileLogger {
    let bl = this.brainLoggers.get(brainId);
    if (!bl) {
      const logDir = this.pathManager!.logsDir(brainId);
      bl = new BrainFileLogger(logDir);
      this.brainLoggers.set(brainId, bl);
    }
    return bl;
  }

  private rotateGlobal(): void {
    this.globalDebugStream.end();
    for (let i = MAX_ROTATIONS - 1; i >= 1; i--) {
      const from = `${this.globalDebugPath}.${i}`;
      const to = `${this.globalDebugPath}.${i + 1}`;
      if (existsSync(from)) renameSync(from, to);
    }
    if (existsSync(this.globalDebugPath)) renameSync(this.globalDebugPath, `${this.globalDebugPath}.1`);
    this.globalDebugStream = createWriteStream(this.globalDebugPath, { flags: "a" });
    this.globalDebugBytes = 0;
  }

  async flush(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.globalDebugStream.writableNeedDrain) {
        resolve();
      } else {
        this.globalDebugStream.once("drain", resolve);
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    detachConsoleLogger(this);
    await this.flush();
    for (const bl of this.brainLoggers.values()) bl.close();
    this.brainLoggers.clear();
    return new Promise((resolve) => this.globalDebugStream.end(resolve));
  }
}
