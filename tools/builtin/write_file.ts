import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ToolDefinition, ToolOutput } from "../../src/core/types.js";

export default {
  name: "write_file",
  description:
    "Write content to a file, creating parent directories if needed. " +
    "Overwrites the file if it already exists. " +
    "If this is an existing file, you MUST use read_file first. " +
    "ALWAYS prefer edit_file for modifying existing files — only use write_file for new files or full rewrites. " +
    "Use this when edit_file fails repeatedly, or when the changes are too large for precise string matching.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path. Relative paths resolve from currentDir. Absolute paths must be under bundle/ (e.g. bundle/shared/docs/) — writing outside bundle/ will be denied.",
      },
      contents: {
        type: "string",
        description: "The full content to write to the file",
      },
    },
    required: ["path", "contents"],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const absPath = ctx.pathManager.resolve(
      { path: String(args.path) },
      ctx.brainId,
    );

    if (!ctx.pathManager.checkPermission(absPath, "write", ctx.brainId, false)) {
      return `Permission denied: cannot write to ${absPath}`;
    }

    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, String(args.contents));

    return `Wrote ${String(args.contents).length} bytes to ${absPath}`;
  },
} satisfies ToolDefinition;
