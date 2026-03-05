import { createWriteStream, statSync, renameSync, existsSync, mkdirSync } from "node:fs";
import type { WriteStream } from "node:fs";
import { join } from "node:path";
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

function ts(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
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

    let line = `[${ts()}] [${LEVEL_LABELS[level]}] [${brainId}#${turn}] ${msg}`;
    if (err) line += `\n  ${err.stack ?? err.message}`;
    line += "\n";

    switch (level) {
      case LogLevel.DEBUG:
        process.stderr.write(line);
        break;
      case LogLevel.INFO:
        process.stderr.write(line);
        break;
      case LogLevel.WARN:
      case LogLevel.ERROR:
        process.stderr.write(line);
        break;
    }

    this.globalDebugStream.write(line);
    this.globalDebugBytes += Buffer.byteLength(line);
    if (this.globalDebugBytes >= MAX_FILE_SIZE) this.rotateGlobal();

    const baseBrainId = brainId.split(":")[0];
    if (baseBrainId && baseBrainId !== "scheduler" && this.pathManager) {
      const logger = this.getOrCreateBrainLogger(baseBrainId);
      logger.write(line, level >= LogLevel.INFO);
    }
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
    await this.flush();
    for (const bl of this.brainLoggers.values()) bl.close();
    this.brainLoggers.clear();
    return new Promise((resolve) => this.globalDebugStream.end(resolve));
  }
}
