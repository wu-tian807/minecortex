import { readFile } from "node:fs/promises";
import { join, resolve, basename, extname } from "node:path";
import type { ToolDefinition, ToolOutput } from "../src/core/types.js";

const ROOT = process.cwd();

type LspOp = "go_to_definition" | "find_references" | "hover" | "document_symbols";

async function readFileContent(filePath: string): Promise<string> {
  return readFile(filePath, "utf-8");
}

function extractSymbolAtPosition(lines: string[], line: number, char: number): string | null {
  if (line < 0 || line >= lines.length) return null;
  const row = lines[line];
  if (char < 0 || char >= row.length) return null;

  const before = row.slice(0, char + 1);
  const after = row.slice(char);
  const mBefore = before.match(/[\w$]+$/);
  const mAfter = after.match(/^[\w$]+/);
  if (!mBefore && !mAfter) return null;
  return (mBefore?.[0] ?? "").slice(0, -1) + (mAfter?.[0] ?? "");
}

async function grepForSymbol(
  symbol: string,
  ctx: { terminalManager: any; brainId: string },
): Promise<string> {
  const result = await ctx.terminalManager.exec(
    `rg -n --no-heading "\\b${symbol}\\b" --type-add 'code:*.{ts,tsx,js,jsx,py,go,rs,java}' -t code -l`,
    { brainId: ctx.brainId, timeoutMs: 10_000 },
  );
  return result.stdout ?? "";
}

async function goToDefinition(
  file: string,
  line: number,
  char: number,
  ctx: any,
): Promise<string> {
  const content = await readFileContent(file);
  const lines = content.split("\n");
  const symbol = extractSymbolAtPosition(lines, line, char);
  if (!symbol) return "No symbol found at the given position.";

  const defPattern = new RegExp(
    `(?:export\\s+)?(?:function|const|let|var|class|interface|type|enum)\\s+${symbol}\\b`,
  );

  const result = await ctx.terminalManager.exec(
    `rg -n --no-heading "${defPattern.source}" --type-add 'code:*.{ts,tsx,js,jsx}' -t code`,
    { brainId: ctx.brainId, timeoutMs: 10_000, cwd: ROOT },
  );

  if (!result.stdout?.trim()) {
    return `No definition found for '${symbol}' (grep heuristic).`;
  }

  const matches = result.stdout.trim().split("\n").slice(0, 10);
  return `Definition candidates for '${symbol}':\n${matches.join("\n")}`;
}

async function findReferences(
  file: string,
  line: number,
  char: number,
  ctx: any,
): Promise<string> {
  const content = await readFileContent(file);
  const lines = content.split("\n");
  const symbol = extractSymbolAtPosition(lines, line, char);
  if (!symbol) return "No symbol found at the given position.";

  const result = await ctx.terminalManager.exec(
    `rg -n --no-heading "\\b${symbol}\\b" --type-add 'code:*.{ts,tsx,js,jsx}' -t code`,
    { brainId: ctx.brainId, timeoutMs: 10_000, cwd: ROOT },
  );

  if (!result.stdout?.trim()) {
    return `No references found for '${symbol}'.`;
  }

  const matches = result.stdout.trim().split("\n");
  const header = `References for '${symbol}' (${matches.length} match${matches.length > 1 ? "es" : ""}):`;
  return `${header}\n${matches.slice(0, 30).join("\n")}${matches.length > 30 ? `\n... and ${matches.length - 30} more` : ""}`;
}

async function hover(file: string, line: number, char: number): Promise<string> {
  const content = await readFileContent(file);
  const lines = content.split("\n");
  const symbol = extractSymbolAtPosition(lines, line, char);
  if (!symbol) return "No symbol found at the given position.";

  const start = Math.max(0, line - 3);
  const end = Math.min(lines.length, line + 4);
  const context = lines
    .slice(start, end)
    .map((l, i) => `${start + i + 1}${i + start === line ? " > " : "   "}| ${l}`)
    .join("\n");

  return `Symbol: ${symbol}\nFile: ${file}:${line + 1}:${char + 1}\n\n${context}`;
}

async function documentSymbols(file: string): Promise<string> {
  const content = await readFileContent(file);
  const lines = content.split("\n");
  const ext = extname(file);

  const patterns: [string, RegExp][] = [
    ["export", /^export\s+(?:default\s+)?(?:abstract\s+)?(?:function|const|let|var|class|interface|type|enum)\s+([\w$]+)/],
    ["function", /^(?:async\s+)?function\s+([\w$]+)/],
    ["class", /^(?:export\s+)?(?:abstract\s+)?class\s+([\w$]+)/],
    ["interface", /^(?:export\s+)?interface\s+([\w$]+)/],
    ["type", /^(?:export\s+)?type\s+([\w$]+)/],
    ["const", /^(?:export\s+)?const\s+([\w$]+)/],
  ];

  if ([".py"].includes(ext)) {
    patterns.length = 0;
    patterns.push(
      ["class", /^class\s+([\w]+)/],
      ["function", /^(?:async\s+)?def\s+([\w]+)/],
    );
  }

  const symbols: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    for (const [kind, pat] of patterns) {
      const m = trimmed.match(pat);
      if (m) {
        symbols.push(`  L${i + 1}  [${kind}] ${m[1]}`);
        break;
      }
    }
  }

  if (symbols.length === 0) return `No symbols found in ${basename(file)}.`;
  return `Symbols in ${basename(file)} (${symbols.length}):\n${symbols.join("\n")}`;
}

export default {
  name: "lsp",
  description:
    "Code intelligence operations: go_to_definition, find_references, hover (context around position), " +
    "and document_symbols (list exports/classes/functions). Uses grep-based heuristics.",
  input_schema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ["go_to_definition", "find_references", "hover", "document_symbols"],
        description: "LSP operation to perform",
      },
      file: {
        type: "string",
        description: "File path (absolute or project-relative)",
      },
      line: {
        type: "integer",
        description: "0-based line number (required for go_to_definition, find_references, hover)",
      },
      character: {
        type: "integer",
        description: "0-based character offset (required for go_to_definition, find_references, hover)",
      },
    },
    required: ["operation", "file"],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const op = String(args.operation) as LspOp;
    const rawFile = String(args.file);
    const file = resolve(ROOT, rawFile);
    const line = typeof args.line === "number" ? args.line : 0;
    const char = typeof args.character === "number" ? args.character : 0;

    try {
      switch (op) {
        case "go_to_definition":
          return await goToDefinition(file, line, char, ctx);
        case "find_references":
          return await findReferences(file, line, char, ctx);
        case "hover":
          return await hover(file, line, char);
        case "document_symbols":
          return await documentSymbols(file);
        default:
          return `Unknown operation: ${op}`;
      }
    } catch (err: any) {
      return `lsp error: ${err.message ?? err}`;
    }
  },
} satisfies ToolDefinition;
