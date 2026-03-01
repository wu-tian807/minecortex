import { statSync } from "node:fs";
import { resolve, relative } from "node:path";
import type { ToolDefinition } from "../src/core/types.js";
import { buildFocusContent } from "../slots/context-file.js";

const ROOT = process.cwd();

export default {
  name: "focus",
  description:
    "Switch working focus to a directory. Updates the context-file slot " +
    "with AGENTS.md/README.md and directory tree from the target path. " +
    "Call with no path to reset to the brain's default directory.",
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

    ctx.slot.release("context-file:current");

    const content = buildFocusContent(targetPath);
    ctx.slot.register("context-file:current", content);

    const rel = relative(ROOT, targetPath) || ".";
    return `Focus set to: ${rel}`;
  },
} satisfies ToolDefinition;
