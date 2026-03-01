import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolDefinition, ToolOutput, BrainJson } from "../src/core/types.js";

const DEFAULT_TIMEOUT = 30_000;

export default {
  name: "shell",
  description:
    "Execute a shell command via the terminal manager. Commands that exceed the timeout " +
    "are automatically backgrounded — use the returned terminalId to check output later. " +
    "Environment variables from the brain's brain.json env field are merged in.",
  input_schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command to execute",
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
        description: "Additional environment variables to set",
      },
    },
    required: ["command"],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const command = String(args.command);
    const cwd = args.cwd ? String(args.cwd) : undefined;
    const timeoutMs = (args.timeout_ms as number) ?? DEFAULT_TIMEOUT;

    let brainEnv: Record<string, string> = {};
    try {
      const brainJsonPath = join(ctx.pathManager.brainDir(ctx.brainId), "brain.json");
      const raw = await readFile(brainJsonPath, "utf-8");
      const brainConfig: BrainJson = JSON.parse(raw);
      if (brainConfig.env) brainEnv = brainConfig.env;
    } catch {
      // no brain.json env — fine
    }

    const mergedEnv = {
      ...brainEnv,
      ...(args.env as Record<string, string> | undefined),
    };

    const result = await ctx.terminalManager.exec(command, {
      cwd,
      env: Object.keys(mergedEnv).length > 0 ? mergedEnv : undefined,
      brainId: ctx.brainId,
      timeoutMs,
    });

    const parts: string[] = [];
    if (result.backgrounded) {
      parts.push(`[backgrounded] Command still running (terminal: ${result.terminalId})`);
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
