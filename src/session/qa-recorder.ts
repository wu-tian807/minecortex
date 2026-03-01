import { appendFile } from "node:fs/promises";
import { join } from "node:path";

export class QARecorder {
  private filePath: string;
  private closed = false;

  constructor(sessionDir: string) {
    this.filePath = join(sessionDir, "qa.md");
  }

  async recordUser(content: string): Promise<void> {
    if (this.closed) return;
    await appendFile(this.filePath, `## User\n${sanitize(content)}\n\n`, "utf-8");
  }

  async recordAssistant(content: string): Promise<void> {
    if (this.closed) return;
    await appendFile(this.filePath, `## Assistant\n${sanitize(content)}\n\n`, "utf-8");
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
