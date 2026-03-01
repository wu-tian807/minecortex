import { readFile, access } from "node:fs/promises";
import { extname } from "node:path";
import type { ToolDefinition, ToolOutput, ContentPart } from "../src/core/types.js";

const MAX_CHARS = 256_000;
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
      return `Error: permission denied — cannot read ${absPath}`;
    }

    try {
      await access(absPath);
    } catch {
      return `Error: file not found — ${absPath}`;
    }

    const ext = extname(absPath).toLowerCase();

    if (IMAGE_EXTS.has(ext)) {
      try {
        const buf = await readFile(absPath);
        const parts: ContentPart[] = [
          { type: "image", data: buf.toString("base64"), mimeType: MIME_MAP[ext]! },
        ];
        return parts;
      } catch (e: any) {
        return `Error: failed to read image — ${e.message}`;
      }
    }

    let raw: string;
    try {
      raw = await readFile(absPath, "utf-8");
    } catch (e: any) {
      return `Error: failed to read file — ${e.message}`;
    }

    if (raw.length === 0) {
      return "File is empty.";
    }

    const allLines = raw.split("\n");
    const totalLines = allLines.length;
    const offset = args.offset as number | undefined;
    const limit = args.limit as number | undefined;

    let start: number;
    if (offset !== undefined && offset < 0) {
      start = Math.max(0, totalLines + offset);
    } else if (offset !== undefined) {
      start = Math.max(0, offset - 1);
    } else {
      start = 0;
    }

    const end = limit !== undefined
      ? Math.min(totalLines, start + limit)
      : totalLines;

    const numbered: string[] = [];
    let charCount = 0;
    let truncatedAtLine = -1;

    for (let i = start; i < end; i++) {
      let line = allLines[i];
      if (line.length > MAX_LINE_LENGTH) {
        line = line.slice(0, MAX_LINE_LENGTH) + ` [... truncated ${allLines[i].length - MAX_LINE_LENGTH} chars]`;
      }
      const formatted = `${String(i + 1).padStart(6)}|${line}\n`;

      if (charCount + formatted.length > MAX_CHARS && limit === undefined) {
        truncatedAtLine = i;
        break;
      }

      numbered.push(formatted);
      charCount += formatted.length;
    }

    const result = numbered.join("").trimEnd();

    if (truncatedAtLine !== -1) {
      const shown = truncatedAtLine - start;
      return result + `\n\n[Output truncated: file has ${totalLines} lines (${raw.length} chars), showed lines ${start + 1}–${truncatedAtLine}. Use offset/limit to read the rest.]`;
    }

    if (end < totalLines && limit !== undefined) {
      return result + `\n\n[Showing lines ${start + 1}–${end} of ${totalLines} total.]`;
    }

    return result;
  },
} satisfies ToolDefinition;
