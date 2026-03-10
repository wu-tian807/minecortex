import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ToolDefinition, ToolOutput } from "../../src/core/types.js";

function matchGlob(pattern: string, path: string): boolean {
  const regex = globToRegex(pattern);
  return regex.test(path);
}

function globToRegex(pattern: string): RegExp {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") {
        re += "(?:.+/)?";
        i += 3;
      } else {
        re += ".*";
        i += 2;
      }
    } else if (c === "*") {
      re += "[^/]*";
      i++;
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else if (c === ".") {
      re += "\\.";
      i++;
    } else {
      re += c;
      i++;
    }
  }
  return new RegExp(`^${re}$`);
}

async function walkDir(dir: string, base: string, results: string[]): Promise<void> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".git" || entry === "dist") continue;
    const full = join(dir, entry);
    const rel = relative(base, full);
    const s = await stat(full).catch(() => null);
    if (!s) continue;
    if (s.isDirectory()) {
      results.push(rel + "/");
      await walkDir(full, base, results);
    } else {
      results.push(rel);
    }
  }
}

export default {
  name: "glob",
  description:
    "Fast file pattern matching tool. Patterns not starting with '**/' are auto-prepended " +
    "for recursive search. Returns matching file paths. Skips node_modules, .git, dist. " +
    "It is always better to speculatively perform multiple searches as a batch.",
  input_schema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description:
          "Glob pattern to match files (e.g. '*.ts', '**/*.json', 'src/**/*.ts')",
      },
      path: {
        type: "string",
        description: "Base directory to search from. Defaults to project root.",
      },
    },
    required: ["pattern"],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    let pattern = String(args.pattern);
    if (!pattern.startsWith("**/") && !pattern.startsWith("/")) {
      pattern = "**/" + pattern;
    }

    const baseDir = ctx.pathManager.resolve(
      { path: String(args.path ?? ".") },
      ctx.brainId,
    );

    const allPaths: string[] = [];
    await walkDir(baseDir, baseDir, allPaths);

    const matched = allPaths
      .filter(p => !p.endsWith("/"))
      .filter(p => matchGlob(pattern, p));

    if (matched.length === 0) return `No files matched pattern: ${pattern}`;
    return matched.sort().join("\n");
  },
} satisfies ToolDefinition;
