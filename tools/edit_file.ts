import { readFile, writeFile } from "node:fs/promises";
import type { ToolDefinition, ToolOutput } from "../src/core/types.js";

export default {
  name: "edit_file",
  description:
    "Edit a file by replacing an exact string match with new content. " +
    "The old_string must uniquely match a section of the file. " +
    "Provide enough surrounding context to ensure uniqueness.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path (absolute, project-relative, or brain-local)",
      },
      old_string: {
        type: "string",
        description: "The exact text to find and replace (must be unique in the file)",
      },
      new_string: {
        type: "string",
        description: "The replacement text",
      },
      brain: {
        type: "string",
        description: "Optional brain ID to resolve path relative to that brain's directory",
      },
    },
    required: ["path", "old_string", "new_string"],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const absPath = ctx.pathManager.resolve(
      { path: String(args.path), brain: args.brain as string | undefined },
      ctx.brainId,
    );

    if (!ctx.pathManager.checkPermission(absPath, "write", ctx.brainId, false)) {
      return `Permission denied: cannot write to ${absPath}`;
    }

    const oldStr = String(args.old_string);
    const newStr = String(args.new_string);

    if (oldStr === newStr) {
      return "old_string and new_string are identical — nothing to change";
    }

    const content = await readFile(absPath, "utf-8");

    const occurrences = content.split(oldStr).length - 1;
    if (occurrences === 0) {
      return `old_string not found in ${absPath}. Make sure the text matches exactly, including whitespace and indentation.`;
    }
    if (occurrences > 1) {
      return `old_string found ${occurrences} times in ${absPath}. Provide more context to make it unique.`;
    }

    const updated = content.replace(oldStr, newStr);
    await writeFile(absPath, updated);

    return `Edited ${absPath}: replaced 1 occurrence`;
  },
} satisfies ToolDefinition;
