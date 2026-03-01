export interface ParsedCommand {
  toolName: string;
  target: string;       // "all" (broadcast), "/" (CLI mode), "<brain_id>" (specific brain)
  args: Record<string, string>;
}

/**
 * Parse a slash command string.
 * Syntax: /<tool-name> <target> -param1 value1 -param2 value2
 *
 * Examples:
 *   /compact /               → { toolName: "compact", target: "/", args: {} }
 *   /focus architect         → { toolName: "focus", target: "architect", args: {} }
 *   /shell all -command ls   → { toolName: "shell", target: "all", args: { command: "ls" } }
 */
export function parseCommand(input: string): ParsedCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;

  const tokens = tokenize(trimmed.slice(1)); // drop leading /
  if (tokens.length === 0) return null;

  const toolName = tokens[0];
  let target = "/"; // default: CLI mode
  let argStart = 1;

  if (tokens.length > 1 && !tokens[1].startsWith("-")) {
    target = tokens[1];
    argStart = 2;
  }

  const args: Record<string, string> = {};
  for (let i = argStart; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith("-")) {
      const key = token.replace(/^-+/, "");
      const value = i + 1 < tokens.length && !tokens[i + 1].startsWith("-")
        ? tokens[++i]
        : "true";
      args[key] = value;
    }
  }

  return { toolName, target, args };
}

/** Split input respecting quoted strings */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote: string | null = null;

  for (const ch of input) {
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === " " || ch === "\t") {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }

  if (current.length > 0) tokens.push(current);
  return tokens;
}
