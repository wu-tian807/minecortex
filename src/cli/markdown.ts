/** @desc Lightweight ANSI Markdown renderer — no external dependencies.
 *
 * Converts a Markdown string to ANSI-escaped terminal output.
 * Covers: fenced code blocks, inline code, bold, italic, strikethrough,
 *         headings (h1–h6), bullet/ordered/task lists, blockquotes,
 *         horizontal rules, tables, images, and links.
 *
 * Design notes (aligned with Claude Code / Gemini CLI philosophy):
 *  - Zero external deps; pure string transformation.
 *  - Used for post-stream rendering of complete `assistant` messages.
 *  - Streaming chunks are output as raw text first, then replaced on finalize.
 */

import { C } from "./ansi.js";

// ─── Extra ANSI codes not in C ───

const A = {
  italic:        "\x1b[3m",
  strikethrough: "\x1b[9m",
  bgDark:        "\x1b[48;5;236m",  // dark grey background for code blocks
  fgCode:        "\x1b[38;5;222m",  // warm yellow for code text
  fgInlineCode:  "\x1b[38;5;215m",  // soft orange for inline code
  underline:     "\x1b[4m",
  reset:         C.reset,
} as const;

// ─── Inline Markdown renderer ───

const INLINE_RULES: Array<{ re: RegExp; fn: (...args: string[]) => string }> = [
  // inline code — highest priority
  {
    re: /`([^`]+)`/g,
    fn: (_, code) => `${A.bgDark}${A.fgInlineCode}${code}${A.reset}`,
  },
  // bold+italic ***text*** or ___text___
  {
    re: /(\*{3}|_{3})(.+?)\1/g,
    fn: (_, _d, text) => `${C.bold}${A.italic}${text}${A.reset}`,
  },
  // bold **text** or __text__
  {
    re: /(\*{2}|_{2})(.+?)\1/g,
    fn: (_, _d, text) => `${C.bold}${text}${A.reset}`,
  },
  // italic *text* or _text_
  {
    re: /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)|(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g,
    fn: (_, a, b) => `${A.italic}${a ?? b}${A.reset}`,
  },
  // strikethrough ~~text~~
  {
    re: /~~(.+?)~~/g,
    fn: (_, text) => `${A.strikethrough}${text}${A.reset}`,
  },
  // image ![alt](url)
  {
    re: /!\[([^\]]*)\]\([^)]+\)/g,
    fn: (_, alt) => `${C.dim}[🖼 ${alt || "image"}]${A.reset}`,
  },
  // markdown link [text](url)
  {
    re: /\[([^\]]+)\]\(([^)]+)\)/g,
    fn: (_, text, url) => `${C.cyan}${text}${C.reset}${C.dim} (${url})${A.reset}`,
  },
];

function renderInline(text: string): string {
  let result = text;
  for (const rule of INLINE_RULES) {
    result = result.replace(rule.re, rule.fn as (...args: string[]) => string);
  }
  return result;
}

// ─── Block-level types ───

type Block =
  | { type: "code";       lang: string; lines: string[] }
  | { type: "heading";    level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { type: "hr" }
  | { type: "blockquote"; lines: string[] }
  | { type: "list";       ordered: boolean; items: ListItem[] }
  | { type: "table";      header: string[]; rows: string[][] }
  | { type: "paragraph";  lines: string[] }
  | { type: "blank" };

interface ListItem {
  text: string;
  checked: boolean | null; // null = not a task item
  indent: number;
}

const HR_RE       = /^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/;
const TABLE_ROW_RE = /^\|.+\|$/;
const TABLE_SEP_RE = /^\|[ \t:|-]+\|$/;

// ─── Block parser ───

function parseBlocks(raw: string): Block[] {
  const lines  = raw.split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // ── Fenced code block ──
    const fenceMatch = /^(`{3,}|~{3,})\s*(\S*)/.exec(line);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      const lang  = fenceMatch[2] ?? "";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith(fence)) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      blocks.push({ type: "code", lang, lines: codeLines });
      continue;
    }

    // ── Heading (h1–h6) ──
    const headingMatch = /^(#{1,6})\s+(.+)/.exec(line);
    if (headingMatch) {
      const level = headingMatch[1].length as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ type: "heading", level, text: headingMatch[2] });
      i++;
      continue;
    }

    // ── Horizontal rule ──
    if (HR_RE.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    // ── Table ──
    if (TABLE_ROW_RE.test(line)) {
      const header = parseCells(line);
      i++;
      const rows: string[][] = [];
      if (i < lines.length && TABLE_SEP_RE.test(lines[i])) i++; // skip separator
      while (i < lines.length && TABLE_ROW_RE.test(lines[i])) {
        rows.push(parseCells(lines[i]));
        i++;
      }
      blocks.push({ type: "table", header, rows });
      continue;
    }

    // ── Blockquote ──
    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ type: "blockquote", lines: quoteLines });
      continue;
    }

    // ── List (bullet, ordered, task) with indentation ──
    if (/^(\s*)(\d+\.\s|[-*+]\s)/.test(line)) {
      const items: ListItem[] = [];
      let ordered = false;
      while (i < lines.length) {
        const m = /^(\s*)(\d+\.\s|[-*+]\s)(.*)/.exec(lines[i]);
        if (!m) break;
        ordered = ordered || /^\d+\.\s/.test(m[2]);
        const indent   = m[1].length;
        const content  = m[3];
        const taskMatch = /^\[([xX ])\]\s*(.+)/.exec(content);
        if (taskMatch) {
          items.push({ text: taskMatch[2], checked: taskMatch[1].toLowerCase() === "x", indent });
        } else {
          items.push({ text: content, checked: null, indent });
        }
        i++;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    // ── Blank line ──
    if (/^\s*$/.test(line)) {
      blocks.push({ type: "blank" });
      i++;
      continue;
    }

    // ── Paragraph ──
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^(`{3,}|~{3,})/.test(lines[i]) &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !HR_RE.test(lines[i]) &&
      !TABLE_ROW_RE.test(lines[i]) &&
      !/^>/.test(lines[i]) &&
      !/^(\s*)(\d+\.\s|[-*+]\s)/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) blocks.push({ type: "paragraph", lines: paraLines });
  }

  return blocks;
}

function parseCells(row: string): string[] {
  return row.split("|").slice(1, -1).map(c => c.trim());
}

// ─── Table rendering ───

function visLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function renderTable(header: string[], rows: string[][]): string {
  const allRows = [header, ...rows];
  const cols    = Math.max(header.length, ...rows.map(r => r.length));
  const widths  = Array.from({ length: cols }, (_, c) =>
    Math.max(...allRows.map(r => visLen(r[c] ?? "")))
  );

  const border = (l: string, m: string, r: string): string =>
    `${C.dim}${l}${widths.map(w => "─".repeat(w + 2)).join(m)}${r}${C.reset}`;

  const row = (cells: string[], bold: boolean): string =>
    `${C.dim}│${C.reset}` +
    cells.map((c, ci) => {
      const padded = c.padEnd(widths[ci] ?? 0, " ");
      return ` ${bold ? C.bold : ""}${renderInline(padded)}${bold ? A.reset : ""} ${C.dim}│${C.reset}`;
    }).join("") + "\n";

  return [
    "\n",
    border("┌", "┬", "┐") + "\n",
    row(header, true),
    border("├", "┼", "┤") + "\n",
    ...rows.map(r => row(Array.from({ length: cols }, (_, c) => r[c] ?? ""), false)),
    border("└", "┴", "┘"),
  ].join("");
}

// ─── Block renderer ───

function renderBlock(block: Block): string {
  switch (block.type) {
    case "blank": return "";

    case "hr": {
      const width = Math.min(process.stdout.columns ?? 80, 80);
      return `\n${C.dim}${"─".repeat(width)}${C.reset}\n`;
    }

    case "heading": {
      const { level, text } = block;
      const prefix =
        level === 1 ? "█ " :
        level === 2 ? "▌ " :
        level === 3 ? "▎ " : "  ";
      const style =
        level === 1 ? `${C.bold}${A.underline}` :
        level === 2 ? `${C.bold}` :
        level === 3 ? `${C.bold}${C.dim}` :
                      `${C.dim}`;
      return `\n${style}${prefix}${renderInline(text)}${A.reset}\n`;
    }

    case "code": {
      const termWidth = process.stdout.columns ?? 80;
      const barWidth  = Math.min(termWidth - 2, 76);
      const bar       = "─".repeat(barWidth);
      const header    = block.lang
        ? `${C.dim}┌${bar} ${block.lang}${A.reset}\n`
        : `${C.dim}┌${bar}${A.reset}\n`;
      const footer    = `${C.dim}└${bar}${A.reset}`;
      const body      = block.lines
        .map(l => `${A.bgDark}${A.fgCode}${l}${A.reset}`)
        .join("\n");
      return `\n${header}${body}\n${footer}\n`;
    }

    case "blockquote": {
      const rendered = block.lines
        .map(l => `${C.dim}▎ ${renderInline(l)}${A.reset}`)
        .join("\n");
      return `\n${rendered}\n`;
    }

    case "list": {
      let orderedIdx = 0;
      const rendered = block.items.map((item) => {
        const pad = " ".repeat(item.indent);
        let bullet: string;
        if (item.checked !== null) {
          bullet = item.checked ? `${C.green}✓${C.reset}` : `${C.dim}○${C.reset}`;
        } else if (block.ordered) {
          bullet = `${C.dim}${++orderedIdx}.${C.reset}`;
        } else {
          bullet = `${C.cyan}•${C.reset}`;
        }
        return `${pad}  ${bullet} ${renderInline(item.text)}`;
      }).join("\n");
      return `\n${rendered}\n`;
    }

    case "table":
      return renderTable(block.header, block.rows);

    case "paragraph": {
      const text = block.lines.join(" ");
      return `\n${renderInline(text)}\n`;
    }
  }
}

// ─── Public API ───

/** Render a complete Markdown string to ANSI-escaped terminal output. */
export function renderMarkdown(text: string): string {
  if (!text) return "";
  const blocks = parseBlocks(text);
  const parts  = blocks.map(renderBlock);
  return parts
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}
