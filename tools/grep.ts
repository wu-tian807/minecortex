import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ToolDefinition, ToolOutput } from "../src/core/types.js";

const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico",
  ".woff", ".woff2", ".ttf", ".eot",
  ".zip", ".tar", ".gz", ".br",
  ".mp3", ".mp4", ".wav", ".ogg",
  ".pdf", ".exe", ".dll", ".so",
]);

const MAX_MATCHES = 200;

async function searchDir(
  dir: string,
  base: string,
  regex: RegExp,
  results: string[],
  contextLines: number,
): Promise<void> {
  if (results.length >= MAX_MATCHES) return;
  const entries = await readdir(dir).catch(() => [] as string[]);
  for (const entry of entries) {
    if (results.length >= MAX_MATCHES) return;
    if (entry === "node_modules" || entry === ".git" || entry === "dist") continue;
    const full = join(dir, entry);
    const s = await stat(full).catch(() => null);
    if (!s) continue;
    if (s.isDirectory()) {
      await searchDir(full, base, regex, results, contextLines);
    } else {
      const ext = entry.slice(entry.lastIndexOf(".")).toLowerCase();
      if (BINARY_EXTS.has(ext)) continue;
      if (s.size > 1_000_000) continue; // skip files > 1MB

      try {
        const content = await readFile(full, "utf-8");
        const lines = content.split("\n");
        const relPath = relative(base, full);
        const matchedLineNos = new Set<number>();

        for (let i = 0; i < lines.length; i++) {
          regex.lastIndex = 0;
          if (regex.test(lines[i])) {
            matchedLineNos.add(i);
          }
        }

        if (matchedLineNos.size > 0) {
          const displayLines = new Set<number>();
          for (const ln of matchedLineNos) {
            for (let c = Math.max(0, ln - contextLines); c <= Math.min(lines.length - 1, ln + contextLines); c++) {
              displayLines.add(c);
            }
          }

          const sorted = [...displayLines].sort((a, b) => a - b);
          results.push(`\n${relPath}:`);
          let prevLine = -2;
          for (const ln of sorted) {
            if (ln > prevLine + 1 && prevLine >= 0) results.push("--");
            const marker = matchedLineNos.has(ln) ? ":" : "-";
            results.push(`${ln + 1}${marker}${lines[ln]}`);
            prevLine = ln;
          }
        }
      } catch {
        // skip unreadable files
      }
    }
  }
}

export default {
  name: "grep",
  description:
    "Search file contents using a regex pattern. Returns matching lines with file paths " +
    "and line numbers. Skips binary files, node_modules, .git, dist. " +
    "ALWAYS use this tool instead of shell grep/rg. " +
    "Supports full regex syntax (e.g. 'TODO', 'function\\s+\\w+').",
  input_schema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Regex pattern to search for (e.g. 'TODO', 'function\\s+\\w+')",
      },
      path: {
        type: "string",
        description: "Directory or file to search in. Defaults to project root.",
      },
      case_insensitive: {
        type: "boolean",
        description: "Case insensitive search. Default: false",
      },
      context_lines: {
        type: "integer",
        description: "Number of context lines before/after each match. Default: 0",
      },
    },
    required: ["pattern"],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const flags = args.case_insensitive ? "gi" : "g";
    let regex: RegExp;
    try {
      regex = new RegExp(String(args.pattern), flags);
    } catch (e: any) {
      return `Invalid regex: ${e.message}`;
    }

    const searchPath = ctx.pathManager.resolve(
      { path: String(args.path ?? ".") },
      ctx.brainId ?? "",
    );
    const contextLines = (args.context_lines as number) ?? 0;

    const results: string[] = [];

    const s = await stat(searchPath).catch(() => null);
    if (!s) return `Path not found: ${searchPath}`;

    if (s.isDirectory()) {
      await searchDir(searchPath, searchPath, regex, results, contextLines);
    } else {
      await searchDir(
        searchPath.slice(0, searchPath.lastIndexOf("/")),
        searchPath.slice(0, searchPath.lastIndexOf("/")),
        regex,
        results,
        contextLines,
      );
    }

    if (results.length === 0) return `No matches found for pattern: ${args.pattern}`;
    return results.join("\n").trim();
  },
} satisfies ToolDefinition;
