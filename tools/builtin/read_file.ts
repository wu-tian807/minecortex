import { readFile, access } from "node:fs/promises";
import { extname, join } from "node:path";
import type { ToolDefinition, ToolOutput, ContentPart, InputModality, ToolContext } from "../../src/core/types.js";
import { getModelSpec } from "../../src/llm/provider.js";

const MAX_CHARS = 256_000;
const MAX_LINE_LENGTH = 2000;

/** All media types the tool can return, keyed by file extension. */
const MEDIA_MAP: Record<string, { mime: string; modality: InputModality }> = {
  // images
  ".png":  { mime: "image/png",       modality: "image" },
  ".jpg":  { mime: "image/jpeg",      modality: "image" },
  ".jpeg": { mime: "image/jpeg",      modality: "image" },
  ".gif":  { mime: "image/gif",       modality: "image" },
  ".webp": { mime: "image/webp",      modality: "image" },
  // video
  ".mp4":  { mime: "video/mp4",       modality: "video" },
  ".webm": { mime: "video/webm",      modality: "video" },
  ".mov":  { mime: "video/quicktime", modality: "video" },
  // audio
  ".mp3":  { mime: "audio/mpeg",      modality: "audio" },
  ".wav":  { mime: "audio/wav",       modality: "audio" },
  ".ogg":  { mime: "audio/ogg",       modality: "audio" },
  ".m4a":  { mime: "audio/mp4",       modality: "audio" },
};

/** Read the current brain's model name then look up its supported input modalities. */
async function getBrainInputModalities(ctx: ToolContext): Promise<InputModality[]> {
  try {
    const brainDir = ctx.pathManager.local(ctx.brainId).root();
    const raw = await readFile(join(brainDir, "brain.json"), "utf-8");
    const brainJson = JSON.parse(raw) as { models?: { model?: string }; model?: string };
    const model = brainJson.models?.model ?? brainJson.model;
    if (model) return getModelSpec(model).input;
  } catch { /* brain.json missing or malformed — fall through */ }
  return ["text"]; // safe default: assume text-only
}

export default {
  name: "read_file",
  description:
    "Read a file from the filesystem. You MUST read a file before editing or writing to it. " +
    "Supports text files with optional offset/limit for large files, and media files (images, video, audio) " +
    "returned as base64 when the active model supports that modality. " +
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
    const mediaEntry = MEDIA_MAP[ext];

    if (mediaEntry) {
      const modalities = await getBrainInputModalities(ctx);
      if (!modalities.includes(mediaEntry.modality)) {
        return `[${mediaEntry.modality} not returned: model does not support ${mediaEntry.modality} input]`;
      }
      try {
        const buf = await readFile(absPath);
        const parts: ContentPart[] = [
          { type: mediaEntry.modality, data: buf.toString("base64"), mimeType: mediaEntry.mime } as ContentPart,
        ];
        return parts;
      } catch (e: any) {
        return `Error: failed to read ${mediaEntry.modality} file — ${e.message}`;
      }
    }

    let raw: string;
    try {
      const buf = await readFile(absPath);
      if (buf.includes(0)) {
        return `Error: '${absPath}' appears to be a binary file — not readable as text`;
      }
      raw = buf.toString("utf-8");
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
