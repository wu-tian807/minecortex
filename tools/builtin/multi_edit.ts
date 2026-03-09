import { readFile, writeFile } from "node:fs/promises";
import type { ToolDefinition, ToolOutput } from "../src/core/types.js";

interface EditOp {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export default {
  name: "multi_edit",
  description:
    "Perform multiple find-and-replace edits on a single file in one operation. " +
    "Edits are applied sequentially — each edit operates on the result of the previous one. " +
    "Atomic: if any edit fails, none are applied. " +
    "Prefer this over multiple edit_file calls when making several changes to the same file.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path (absolute, project-relative, or brain-local)",
      },
      edits: {
        type: "array",
        items: {
          type: "object",
          properties: {
            old_string: {
              type: "string",
              description: "The exact text to replace",
            },
            new_string: {
              type: "string",
              description: "The replacement text",
            },
            replace_all: {
              type: "boolean",
              description: "Replace all occurrences (default: false)",
            },
          },
          required: ["old_string", "new_string"],
        },
        minItems: 1,
        description: "Array of edit operations to apply sequentially",
      },
    },
    required: ["path", "edits"],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const absPath = ctx.pathManager.resolve(
      { path: String(args.path) },
      ctx.brainId,
    );

    if (!ctx.pathManager.checkPermission(absPath, "write", ctx.brainId, false)) {
      return `Permission denied: cannot write to ${absPath}`;
    }

    const edits = args.edits as EditOp[];
    if (!Array.isArray(edits) || edits.length === 0) {
      return "Error: edits must be a non-empty array.";
    }

    let content = await readFile(absPath, "utf-8");

    for (let i = 0; i < edits.length; i++) {
      const { old_string, new_string, replace_all } = edits[i];

      if (old_string === new_string) {
        return `Edit ${i + 1}/${edits.length} failed: old_string and new_string are identical. No edits applied.`;
      }

      const occurrences = content.split(old_string).length - 1;
      if (occurrences === 0) {
        return `Edit ${i + 1}/${edits.length} failed: old_string not found. No edits applied.`;
      }
      if (occurrences > 1 && !replace_all) {
        return `Edit ${i + 1}/${edits.length} failed: old_string found ${occurrences} times (use replace_all or add context). No edits applied.`;
      }

      content = replace_all
        ? content.replaceAll(old_string, new_string)
        : content.replace(old_string, new_string);
    }

    await writeFile(absPath, content);
    return `Applied ${edits.length} edit${edits.length > 1 ? "s" : ""} to ${absPath}`;
  },
} satisfies ToolDefinition;
