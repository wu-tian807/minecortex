import { statSync } from "node:fs";
import { resolve, relative } from "node:path";
import type { ToolDefinition } from "../../src/core/types.js";
import { BRAINBOARD_KEYS } from "../../src/defaults/brainboard-vars.js";
import { resolveBrainDefaultDir } from "../../src/defaults/brainboard-vars.js";

const ROOT = process.cwd();

export default {
  name: "focus",
  description:
    "Switch working focus to a directory. Sets currentDir in brainboard, " +
    "which makes the context-file slot show CLAUDE.md/AGENTS.md and directory tree " +
    "from the target path, and makes relative tool paths resolve from that directory. " +
    "Call with no path to reset focus to the resolved defaultDir from brain.json (or HOME_DIR if unset).",
  guidance: "Use **focus** to switch context between HOME_DIR, SHARED_WORKSPACE, or any project directory. Omit path to reset to default.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Directory path (absolute or relative to currentDir). Omit to reset to default directory.",
      },
    },
    required: [],
  },
  async execute(args, ctx) {
    const rawPath = args.path as string | undefined;
    const defaultDir = resolveBrainDefaultDir(
      ctx.brainId,
      ctx.getBrainJson(),
      ctx.pathManager,
    );
    const currentDir = (ctx.brainBoard.get(ctx.brainId, BRAINBOARD_KEYS.CURRENT_DIR) as string | undefined)
      ?? defaultDir;
    const targetPath = rawPath
      ? resolve(currentDir, rawPath)
      : defaultDir;

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

    ctx.brainBoard.set(ctx.brainId, BRAINBOARD_KEYS.CURRENT_DIR, targetPath, { persist: false });

    const rel = relative(ROOT, targetPath) || ".";
    return `Focus set to: ${rel}`;
  },
} satisfies ToolDefinition;
