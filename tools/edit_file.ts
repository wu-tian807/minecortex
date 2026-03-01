import { readFile, writeFile } from "node:fs/promises";
import type { ToolDefinition, ToolOutput } from "../src/core/types.js";

export default {
  name: "edit_file",
  description:
    "Performs exact string replacement in a file. " +
    "The old_string must match the file contents exactly including whitespace and indentation. " +
    "old_string MUST include AT LEAST 3-5 lines of context before AND after the change point to ensure uniqueness. " +
    "Before editing, verify that old_string uniquely identifies the target location. " +
    "The edit will FAIL if old_string is not unique — provide more surrounding context to disambiguate, " +
    "or use replace_all to change every instance. " +
    "Use replace_all for renaming variables or updating repeated patterns across the file. " +
    "When constructing old_string from read_file output, do NOT include the line number prefix (e.g. '     1|'). " +
    "For larger edits or when edit_file fails repeatedly, use write_file to rewrite the entire file.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path (absolute, project-relative, or brain-local)",
      },
      old_string: {
        type: "string",
        description: "The exact text to replace (must match file contents exactly)",
      },
      new_string: {
        type: "string",
        description: "The replacement text (must differ from old_string)",
      },
      replace_all: {
        type: "boolean",
        description: "Replace all occurrences of old_string (default: false)",
      },
    },
    required: ["path", "old_string", "new_string"],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const absPath = ctx.pathManager.resolve(
      { path: String(args.path) },
      ctx.brainId,
    );

    if (!ctx.pathManager.checkPermission(absPath, "write", ctx.brainId, false)) {
      return `Permission denied: cannot write to ${absPath}`;
    }

    const oldStr = String(args.old_string);
    const newStr = String(args.new_string);
    const replaceAll = (args.replace_all as boolean) ?? false;

    if (oldStr === newStr) {
      return "old_string and new_string are identical — nothing to change";
    }

    const content = await readFile(absPath, "utf-8");

    const occurrences = content.split(oldStr).length - 1;
    if (occurrences === 0) {
      return `old_string not found in ${absPath}. Make sure the text matches exactly, including whitespace and indentation. Hint: Re-read the file with read_file and copy the exact text. If this keeps failing, use write_file to rewrite the entire file.`;
    }
    if (occurrences > 1 && !replaceAll) {
      return `old_string found ${occurrences} times in ${absPath}. Provide more context to make it unique, or use replace_all.`;
    }

    const updated = replaceAll
      ? content.replaceAll(oldStr, newStr)
      : content.replace(oldStr, newStr);
    await writeFile(absPath, updated);

    return `Edited ${absPath}: replaced ${replaceAll ? occurrences : 1} occurrence${(replaceAll && occurrences > 1) ? "s" : ""}`;
  },
} satisfies ToolDefinition;
