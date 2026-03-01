import { createWriteStream, statSync, renameSync, existsSync } from "node:fs";
import type { WriteStream } from "node:fs";
import { join } from "node:path";

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

export class Logger {
  private stream: WriteStream;
  private queue: string[] = [];
  private writing = false;
  private closed = false;
  private bytesWritten = 0;
  private logPath: string;
  public level: LogLevel = LogLevel.DEBUG;

  constructor(rootDir: string) {
    this.logPath = join(rootDir, "debug.log");
    this.stream = createWriteStream(this.logPath, { flags: "a" });
    try {
      this.bytesWritten = statSync(this.logPath).size;
    } catch {
      this.bytesWritten = 0;
    }
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

    if (level >= LogLevel.INFO) process.stdout.write(line);

    this.queue.push(line);
    this.drainQueue();
  }

  private drainQueue(): void {
    if (this.writing || this.closed || this.queue.length === 0) return;
    this.writing = true;

    const chunk = this.queue.join("");
    this.queue.length = 0;

    this.stream.write(chunk, (writeErr) => {
      this.writing = false;
      if (!writeErr) {
        this.bytesWritten += Buffer.byteLength(chunk);
        if (this.bytesWritten >= MAX_FILE_SIZE) this.rotate();
      }
      if (this.queue.length > 0) this.drainQueue();
    });
  }

  private rotate(): void {
    this.stream.end();
    for (let i = MAX_ROTATIONS - 1; i >= 1; i--) {
      const from = `${this.logPath}.${i}`;
      const to = `${this.logPath}.${i + 1}`;
      if (existsSync(from)) renameSync(from, to);
    }
    if (existsSync(this.logPath)) renameSync(this.logPath, `${this.logPath}.1`);
    this.stream = createWriteStream(this.logPath, { flags: "a" });
    this.bytesWritten = 0;
  }

  async flush(): Promise<void> {
    if (this.queue.length > 0) this.drainQueue();
    return new Promise((resolve) => {
      if (!this.stream.writableNeedDrain) {
        resolve();
      } else {
        this.stream.once("drain", resolve);
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
    return new Promise((resolve) => this.stream.end(resolve));
  }
}
