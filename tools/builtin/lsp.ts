import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JSONRPCEndpoint } from "ts-lsp-client/build/src/jsonRpcEndpoint.js";
import { LspClient } from "ts-lsp-client/build/src/lspClient.js";
import type { ToolDefinition, ToolOutput } from "../../src/core/types.js";

const ROOT = process.cwd();

type LspOp = "go_to_definition" | "find_references" | "hover" | "document_symbols";
const TS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".cts", ".cjs"]);
const PYTHON_EXTENSIONS = new Set([".py"]);

interface LSPClient {
  goToDefinition(file: string, line: number, char: number): Promise<string>;
  findReferences(file: string, line: number, char: number): Promise<string>;
  hover(file: string, line: number, char: number): Promise<string>;
  documentSymbols(file: string): Promise<string>;
}

class TypeScriptLSPClient implements LSPClient {
  private process: ChildProcess | null = null;
  private lsp: any = null;
  private endpoint: any = null;
  private initialized = false;
  private openedFiles = new Set<string>();
  private operationQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly cwd: string) {}

  private async ensureStarted(): Promise<void> {
    if (this.initialized) return;

    const serverPath = this.resolveServerBin();

    this.process = spawn(serverPath, ["--stdio"], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.endpoint = new JSONRPCEndpoint(this.process.stdin!, this.process.stdout!);
    this.endpoint.on("error", () => {});
    this.process.stderr?.on("data", () => {});

    this.lsp = new LspClient(this.endpoint);
    await this.lsp.initialize({
      processId: process.pid,
      capabilities: {},
      rootUri: pathToFileURL(this.cwd).href,
      workspaceFolders: [{ uri: pathToFileURL(this.cwd).href, name: "workspace" }],
    });
    this.lsp.initialized();
    await new Promise((resolveStart) => setTimeout(resolveStart, 500));
    this.initialized = true;
  }

  private resolveServerBin(): string {
    const local = resolve(this.cwd, "node_modules/.bin/typescript-language-server");
    if (existsSync(local)) return local;
    return "typescript-language-server";
  }

  private resolvePath(file: string): string {
    return resolve(this.cwd, file);
  }

  private async openFile(absPath: string): Promise<void> {
    const uri = pathToFileURL(absPath).href;
    if (this.openedFiles.has(uri)) return;

    const content = readFileSync(absPath, "utf-8");
    const languageId = getTypeScriptLanguageId(extname(absPath));

    this.lsp.didOpen({
      textDocument: {
        uri,
        languageId,
        version: 1,
        text: content,
      },
    });

    this.openedFiles.add(uri);
  }

  private async withTimeout<T>(fn: () => Promise<T>, timeoutMs = 10_000): Promise<T> {
    return Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`LSP operation timed out after ${timeoutMs / 1000}s`)), timeoutMs);
      }),
    ]);
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await this.withTimeout(fn);
    } catch (error: any) {
      const message = error?.message ?? "";
      const recoverable =
        message.includes("mismatch") ||
        message.includes("EPIPE") ||
        message.includes("timed out") ||
        !this.process?.connected;

      if (!recoverable) throw error;

      this.initialized = false;
      this.openedFiles.clear();
      try {
        this.process?.kill();
      } catch {}
      this.process = null;

      await this.ensureStarted();
      return this.withTimeout(fn);
    }
  }

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.operationQueue.catch(() => undefined).then(fn);
    this.operationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async goToDefinition(file: string, line: number, char: number): Promise<string> {
    return this.runExclusive(async () => {
      await this.ensureStarted();
      const absPath = this.resolvePath(file);
      await this.openFile(absPath);

      return this.withRetry(async () => {
        const result = await this.lsp.definition({
          textDocument: { uri: pathToFileURL(absPath).href },
          position: { line: line - 1, character: char - 1 },
        });
        return formatLocations(result);
      });
    });
  }

  async findReferences(file: string, line: number, char: number): Promise<string> {
    return this.runExclusive(async () => {
      await this.ensureStarted();
      const absPath = this.resolvePath(file);
      await this.openFile(absPath);

      return this.withRetry(async () => {
        const result = await this.lsp.references({
          textDocument: { uri: pathToFileURL(absPath).href },
          position: { line: line - 1, character: char - 1 },
          context: { includeDeclaration: true },
        });
        return formatLocations(result);
      });
    });
  }

  async hover(file: string, line: number, char: number): Promise<string> {
    return this.runExclusive(async () => {
      await this.ensureStarted();
      const absPath = this.resolvePath(file);
      await this.openFile(absPath);

      return this.withRetry(async () => {
        const result = await this.lsp.hover({
          textDocument: { uri: pathToFileURL(absPath).href },
          position: { line: line - 1, character: char - 1 },
        });
        return formatHover(result?.contents);
      });
    });
  }

  async documentSymbols(file: string): Promise<string> {
    return this.runExclusive(async () => {
      await this.ensureStarted();
      const absPath = this.resolvePath(file);
      await this.openFile(absPath);

      return this.withRetry(async () => {
        const result = await this.lsp.documentSymbol({
          textDocument: { uri: pathToFileURL(absPath).href },
        });
        if (!result || result.length === 0) return "No symbols found.";
        return formatSymbols(result, 0);
      });
    });
  }
}

function getTypeScriptLanguageId(extension: string): string {
  const languageMap: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescriptreact",
    ".js": "javascript",
    ".jsx": "javascriptreact",
    ".mts": "typescript",
    ".mjs": "javascript",
    ".cts": "typescript",
    ".cjs": "javascript",
  };
  return languageMap[extension] ?? "typescript";
}

function formatLocations(locations: any): string {
  if (!locations) return "No results found.";
  const items = Array.isArray(locations) ? locations : [locations];
  if (items.length === 0) return "No results found.";

  return items
    .map((location: any) => {
      const uri = location.uri ?? location.targetUri ?? "";
      const range = location.range ?? location.targetSelectionRange ?? location.targetRange;
      const filePath = uri.startsWith("file://") ? new URL(uri) : null;
      if (!range) return filePath ? filePath.pathname : uri;
      const line = (range.start?.line ?? 0) + 1;
      const char = (range.start?.character ?? 0) + 1;
      return `${filePath ? filePath.pathname : uri}:${line}:${char}`;
    })
    .join("\n");
}

function formatHover(contents: any): string {
  if (!contents) return "No hover information.";
  if (typeof contents === "string") return contents;
  if (typeof contents.value === "string") return contents.value;
  if (Array.isArray(contents)) {
    return contents
      .map((item: any) => {
        if (typeof item === "string") return item;
        if (typeof item?.value === "string") return item.value;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return JSON.stringify(contents);
}

function formatSymbols(symbols: any[], indent: number): string {
  const kindNames: Record<number, string> = {
    1: "File",
    2: "Module",
    3: "Namespace",
    4: "Package",
    5: "Class",
    6: "Method",
    7: "Property",
    8: "Field",
    9: "Constructor",
    10: "Enum",
    11: "Interface",
    12: "Function",
    13: "Variable",
    14: "Constant",
    15: "String",
    16: "Number",
    17: "Boolean",
    18: "Array",
    19: "Object",
    23: "Event",
    24: "Operator",
    25: "TypeParameter",
  };

  const prefix = "  ".repeat(indent);
  return symbols
    .map((symbol) => {
      const kind = kindNames[symbol.kind] ?? `Kind(${symbol.kind})`;
      const line = (symbol.range ?? symbol.location?.range)?.start?.line;
      const lineSuffix = line != null ? `:${line + 1}` : "";
      const detail = symbol.detail ? ` - ${symbol.detail}` : "";
      const children = symbol.children?.length ? `\n${formatSymbols(symbol.children, indent + 1)}` : "";
      return `${prefix}${kind} ${symbol.name}${lineSuffix}${detail}${children}`;
    })
    .join("\n");
}

function getLanguageBoundaryMessage(extension: string): string {
  if (PYTHON_EXTENSIONS.has(extension)) {
    return "Python files are supported in the workspace, but Python LSP/checking is not integrated yet.";
  }
  return `LSP currently supports TypeScript/JavaScript files only. Got: ${extension || "unknown"}`;
}

let sharedClient: TypeScriptLSPClient | null = null;

function getOrCreateClient(cwd: string): TypeScriptLSPClient {
  if (!sharedClient) {
    sharedClient = new TypeScriptLSPClient(cwd);
  }
  return sharedClient;
}

export default {
  name: "lsp",
  description:
    "Language Server Protocol integration for precise TypeScript/JavaScript code intelligence. " +
    "Supports go_to_definition, find_references, hover, and document_symbols. " +
    "Line and character positions are 1-based. Python is a supported workspace language, but Python LSP/checking is not integrated yet.",
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
        description: "1-based line number (required for go_to_definition, find_references, hover)",
      },
      character: {
        type: "integer",
        description: "1-based character offset (required for go_to_definition, find_references, hover)",
      },
    },
    required: ["operation", "file"],
  },
  async execute(args): Promise<ToolOutput> {
    const op = String(args.operation) as LspOp;
    const rawFile = String(args.file);
    const file = resolve(ROOT, rawFile);
    const line = typeof args.line === "number" ? args.line : 1;
    const char = typeof args.character === "number" ? args.character : 1;
    const extension = extname(file);

    try {
      if (!TS_EXTENSIONS.has(extension)) {
        return getLanguageBoundaryMessage(extension);
      }

      const client = getOrCreateClient(ROOT);

      switch (op) {
        case "go_to_definition":
          return await client.goToDefinition(file, line, char);
        case "find_references":
          return await client.findReferences(file, line, char);
        case "hover":
          return await client.hover(file, line, char);
        case "document_symbols":
          return await client.documentSymbols(file);
        default:
          return `Unknown operation: ${op}`;
      }
    } catch (error: any) {
      return `LSP error: ${error?.message ?? error}`;
    }
  },
} satisfies ToolDefinition;
