import type { ToolDefinition, ToolOutput } from "../../src/core/types.js";
import { BRAINBOARD_KEYS } from "../../src/defaults/brainboard-vars.js";
import { getTerminalManager } from "../../src/terminal/manager.js";

const DEFAULT_TIMEOUT = 30_000;

export default {
  name: "shell",
  description:
    "Execute a shell command in a persistent bash session that preserves cwd, venv, and exported vars across calls. " +
    "Commands that exceed the timeout are backgrounded — a new session is created for subsequent commands " +
    "with cwd restored, but any custom 'export' vars set in the timed-out session will be lost. " +
    "Use read_file on the returned logFile path to poll a backgrounded command's progress. " +
    "IMPORTANT: Do not use grep/find/cat/sed/awk — use the dedicated tools (grep, glob, read_file, edit_file) instead. " +
    "Always quote file paths containing spaces. Use ';' or '&&' to chain commands, not newlines.",
  guidance: "**shell**: Always provide the description parameter (5-10 words stating the command's purpose).",
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
        description: "Working directory. Relative paths resolve from currentDir. Defaults to currentDir.",
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
    const initialCwd = ctx.brainBoard.get(ctx.brainId, BRAINBOARD_KEYS.CURRENT_DIR) as string | undefined;
    const timeoutMs = (args.timeout_ms as number) ?? DEFAULT_TIMEOUT;
    const extraEnv = args.env as Record<string, string> | undefined;
    const terminalManager = getTerminalManager();

    const description = args.description ? String(args.description) : undefined;
    const result = await terminalManager.exec(command, {
      cwd,
      initialCwd,
      env: extraEnv,
      brainId: ctx.brainId,
      timeoutMs,
      description,
    });

    const parts: string[] = [];
    if (result.backgrounded) {
      parts.push(`[backgrounded] Command still running in the background.`);
      parts.push(`Shell state (cwd, venv, exports) is preserved — you can run the next command normally.`);
      parts.push(`To check progress, call: read_file("${result.logFile}")`);
    } else {
      parts.push(`Exit code: ${result.exitCode ?? "unknown"}`);
    }
    if (result.stdout) {
      parts.push("", result.stdout);
    }
    return parts.join("\n");
  },
} satisfies ToolDefinition;
