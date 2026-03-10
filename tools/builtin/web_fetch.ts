import type { ToolDefinition } from "../../src/core/types.js";

const DEFAULT_MAX_LENGTH = 80_000;

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export default {
  name: "web_fetch",
  description:
    "Fetch a web page and return its content as plain text. " +
    "HTML is automatically converted to readable text. Follows redirects.",
  input_schema: {
    type: "object" as const,
    properties: {
      url: { type: "string", description: "URL to fetch" },
      max_length: {
        type: "number",
        description: "Maximum content length in characters (default: 80000)",
      },
    },
    required: ["url"],
  },
  async execute(args) {
    const url = String(args.url);
    const maxLength = Number(args.max_length ?? DEFAULT_MAX_LENGTH);

    const res = await fetch(url, {
      headers: { "User-Agent": "MineClaw/1.0" },
      redirect: "follow",
    });

    if (!res.ok) {
      return JSON.stringify({ error: `HTTP ${res.status} ${res.statusText}`, url });
    }

    const contentType = res.headers.get("content-type") ?? "";
    const raw = await res.text();
    const content = contentType.includes("text/html") ? htmlToText(raw) : raw;

    const truncated = content.length > maxLength;
    const final = truncated
      ? content.slice(0, maxLength) + "\n\n[Content truncated]"
      : content;

    return JSON.stringify({
      content: final,
      url,
      length: final.length,
      truncated,
    });
  },
} satisfies ToolDefinition;
