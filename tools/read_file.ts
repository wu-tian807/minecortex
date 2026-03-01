import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { ToolDefinition, ToolOutput, ContentPart } from "../src/core/types.js";

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
    "Read a file from the filesystem. Supports text files with optional offset/limit " +
    "for large files, and image files (png, jpg, gif, webp) which are returned as base64. " +
    "Use the brain param to read files relative to a specific brain directory.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path (absolute, project-relative, or brain-local like 'state.json')",
      },
      brain: {
        type: "string",
        description: "Optional brain ID to resolve path relative to that brain's directory",
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
      { path: String(args.path), brain: args.brain as string | undefined },
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
    const offset = args.offset as number | undefined;
    const limit = args.limit as number | undefined;

    if (offset !== undefined || limit !== undefined) {
      const lines = raw.split("\n");
      let start: number;
      if (offset !== undefined && offset < 0) {
        start = Math.max(0, lines.length + offset);
      } else {
        start = Math.max(0, (offset ?? 1) - 1);
      }
      const end = limit !== undefined ? start + limit : lines.length;
      const slice = lines.slice(start, end);
      const numbered = slice.map((line, i) => `${String(start + i + 1).padStart(6)}|${line}`);
      return numbered.join("\n");
    }

    const lines = raw.split("\n");
    const numbered = lines.map((line, i) => `${String(i + 1).padStart(6)}|${line}`);
    return numbered.join("\n");
  },
} satisfies ToolDefinition;
