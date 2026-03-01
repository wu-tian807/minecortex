import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { ToolDefinition, ToolOutput, ContentPart } from "../src/core/types.js";

const MAX_LINES = 2000;
const MAX_LINE_LENGTH = 2000;

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const MIME_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export default {
  name: "read_file",
  description:
    "Read a file from the filesystem. You MUST read a file before editing or writing to it. " +
    "Supports text files with optional offset/limit for large files, and images (png, jpg, gif, webp) returned as base64. " +
    "It is always better to speculatively read multiple files as a batch that are potentially useful.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path (absolute, project-relative, or brain-local like 'state.json')",
      },
      offset: {
        type: "integer",
        description: "Line number to start reading from (1-indexed). Negative counts from end.",
      },
      limit: {
        type: "integer",
        description: "Number of lines to read from the offset",
      },
    },
    required: ["path"],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const absPath = ctx.pathManager.resolve(
      { path: String(args.path) },
      ctx.brainId,
    );

    if (!ctx.pathManager.checkPermission(absPath, "read", ctx.brainId, false)) {
      return `Permission denied: cannot read ${absPath}`;
    }

    const ext = extname(absPath).toLowerCase();

    if (IMAGE_EXTS.has(ext)) {
      const buf = await readFile(absPath);
      const parts: ContentPart[] = [
        { type: "image", data: buf.toString("base64"), mimeType: MIME_MAP[ext]! },
      ];
      return parts;
    }

    const raw = await readFile(absPath, "utf-8");
    const allLines = raw.split("\n");
    const offset = args.offset as number | undefined;
    const limit = args.limit as number | undefined;

    let start: number;
    if (offset !== undefined && offset < 0) {
      start = Math.max(0, allLines.length + offset);
    } else if (offset !== undefined) {
      start = Math.max(0, offset - 1);
    } else {
      start = 0;
    }

    const maxLines = limit ?? MAX_LINES;
    const end = Math.min(allLines.length, start + maxLines);
    const slice = allLines.slice(start, end);

    const numbered = slice.map((line, i) => {
      const truncated = line.length > MAX_LINE_LENGTH
        ? line.slice(0, MAX_LINE_LENGTH) + ` [... truncated ${line.length - MAX_LINE_LENGTH} chars]`
        : line;
      return `${String(start + i + 1).padStart(6)}|${truncated}`;
    });

    const result = numbered.join("\n");

    if (end < allLines.length && limit === undefined) {
      return result + `\n\n[File has ${allLines.length} lines total, showing first ${MAX_LINES}. Use offset/limit to read more.]`;
    }

    return result;
  },
} satisfies ToolDefinition;
