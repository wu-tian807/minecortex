import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ToolDefinition, ToolOutput } from "../../src/core/types.js";

export default {
  name: "list_dir",
  description:
    "List the contents of a directory. Entries are marked with [dir] or [file]. " +
    "Prefer glob and grep when you know which directory or pattern to search for.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Directory path (absolute or relative to currentDir). Defaults to currentDir.",
      },
    },
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const dirPath = ctx.pathManager.resolve(
      { path: String(args.path ?? ".") },
      ctx.brainId,
    );

    if (!ctx.pathManager.checkPermission(dirPath, "read", ctx.brainId, false)) {
      return `Permission denied: cannot read ${dirPath}`;
    }

    const entries = await readdir(dirPath);
    const lines: string[] = [];

    for (const entry of entries.sort()) {
      try {
        const s = await stat(join(dirPath, entry));
        lines.push(s.isDirectory() ? `[dir]  ${entry}` : `[file] ${entry}`);
      } catch {
        lines.push(`[???]  ${entry}`);
      }
    }

    if (lines.length === 0) return `${dirPath} is empty`;
    return lines.join("\n");
  },
} satisfies ToolDefinition;
