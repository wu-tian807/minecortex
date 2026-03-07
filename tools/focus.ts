import { statSync } from "node:fs";
import { resolve, relative } from "node:path";
import type { ToolDefinition } from "../src/core/types.js";

const ROOT = process.cwd();

export default {
  name: "focus",
  description:
    "Switch working focus to a directory. Sets current_dir in brainboard, " +
    "which makes the context-file slot show CLAUDE.md/AGENTS.md and directory tree " +
    "from the target path, and sets the default cwd for new shell sessions. " +
    "Call with no path to clear focus.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Directory path (absolute or project-relative). Omit to reset to brain root.",
      },
    },
    required: [],
  },
  async execute(args, ctx) {
    const rawPath = args.path as string | undefined;
    const targetPath = rawPath
      ? resolve(ROOT, rawPath)
      : ctx.pathManager.brainDir(ctx.brainId);

    try {
      const st = statSync(targetPath);
      if (!st.isDirectory()) {
        return `Error: ${targetPath} is not a directory.`;
      }
    } catch {
      return `Error: ${targetPath} does not exist.`;
    }

    if (!ctx.pathManager.checkPermission(targetPath, "read", ctx.brainId, false)) {
      return `Permission denied: cannot access ${targetPath}`;
    }

    ctx.brainBoard.set(ctx.brainId, "current_dir", targetPath, { persist: false });

    const rel = relative(ROOT, targetPath) || ".";
    return `Focus set to: ${rel}`;
  },
} satisfies ToolDefinition;
