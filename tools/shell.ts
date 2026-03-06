import type { ToolDefinition, ToolOutput } from "../src/core/types.js";
import { getTerminalManager } from "../src/terminal/manager.js";

const DEFAULT_TIMEOUT = 30_000;

export default {
  name: "shell",
  description:
    "Execute a shell command via the terminal manager. Commands that exceed the timeout " +
    "are automatically backgrounded — use the returned terminalId to check output later. " +
    "IMPORTANT: Do not use grep/find/cat/sed/awk — use the dedicated tools (grep, glob, read_file, edit_file) instead. " +
    "Always quote file paths containing spaces. Use ';' or '&&' to chain commands, not newlines.",
  input_schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command to execute",
      },
      description: {
        type: "string",
        description: "Concise description of what this command does (5-10 words)",
      },
      cwd: {
        type: "string",
        description: "Working directory. Defaults to project root.",
      },
      timeout_ms: {
        type: "integer",
        description: "Timeout in ms before auto-backgrounding. Default: 30000",
      },
      env: {
        type: "object",
        description: "Additional environment variables to set (on top of brain.json env)",
      },
    },
    required: ["command"],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const command = String(args.command);
    const cwd = args.cwd ? String(args.cwd) : undefined;
    const timeoutMs = (args.timeout_ms as number) ?? DEFAULT_TIMEOUT;
    const extraEnv = args.env as Record<string, string> | undefined;
    const terminalManager = getTerminalManager();

    const result = await terminalManager.exec(command, {
      cwd,
      env: extraEnv,
      brainId: ctx.brainId,
      timeoutMs,
    });

    const parts: string[] = [];
    if (result.backgrounded) {
      parts.push(`[backgrounded] Command still running (terminal: ${result.terminalId})`);
      parts.push(`Log file: ${result.logFile}`);
      if (result.hint) parts.push(result.hint);
    } else {
      parts.push(`Exit code: ${result.exitCode ?? "unknown"}`);
    }
    if (result.stdout) {
      parts.push("", result.stdout);
    }
    return parts.join("\n");
  },
} satisfies ToolDefinition;
