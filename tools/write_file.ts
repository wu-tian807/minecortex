import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ToolDefinition, ToolOutput } from "../src/core/types.js";

export default {
  name: "write_file",
  description:
    "Write content to a file, creating parent directories if needed. " +
    "Overwrites the file if it already exists. " +
    "Write permission is checked: own brain dir is always writable, " +
    "other locations require evolve mode, src/ is never writable.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path (absolute, project-relative, or brain-local)",
      },
      contents: {
        type: "string",
        description: "The full content to write to the file",
      },
      brain: {
        type: "string",
        description: "Optional brain ID to resolve path relative to that brain's directory",
      },
    },
    required: ["path", "contents"],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const absPath = ctx.pathManager.resolve(
      { path: String(args.path), brain: args.brain as string | undefined },
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
