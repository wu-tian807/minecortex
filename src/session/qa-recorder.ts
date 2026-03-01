import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export class QARecorder {
  private filePath: string;
  private closed = false;
  private dirCreated = false;

  /**
   * @param logDir - brain-specific log dir (brains/<id>/logs) or session dir for backward compat
   */
  constructor(logDir: string) {
    this.filePath = join(logDir, "qa.md");
  }

  private async ensureDir(): Promise<void> {
    if (this.dirCreated) return;
    const { dirname } = await import("node:path");
    await mkdir(dirname(this.filePath), { recursive: true });
    this.dirCreated = true;
  }

  async recordUser(content: string): Promise<void> {
    if (this.closed) return;
    await this.ensureDir();
    await appendFile(this.filePath, `## User\n${sanitize(content)}\n\n`, "utf-8");
  }

  async recordAssistant(content: string): Promise<void> {
    if (this.closed) return;
    await this.ensureDir();
    await appendFile(this.filePath, `## Assistant\n${sanitize(content)}\n\n`, "utf-8");
  }

  async recordToolResult(name: string, result: string, durationMs: number): Promise<void> {
    if (this.closed) return;
    await this.ensureDir();
    const preview = result.slice(0, 500);
    const suffix = result.length > 500 ? "..." : "";
    await appendFile(
      this.filePath,
      `### Tool: ${name} (${durationMs}ms)\n\`\`\`\n${preview}${suffix}\n\`\`\`\n\n`,
      "utf-8",
    );
  }

  close(): void {
    this.closed = true;
  }
}

function sanitize(raw: string): string {
  return raw
    .replace(/<thinking>[\s\S]*?<\/thinking>/g, "")
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/g, "")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .replace(/<tool_result>[\s\S]*?<\/tool_result>/g, "")
    .replace(/<system>[\s\S]*?<\/system>/g, "")
    .trim();
}
