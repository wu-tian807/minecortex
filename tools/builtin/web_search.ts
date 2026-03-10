import type { ToolDefinition } from "../../src/core/types.js";

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

async function tavilySearch(query: string, maxResults: number): Promise<SearchResult[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("no_api_key");

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey, query, max_results: maxResults }),
  });

  if (!res.ok) throw new Error(`Tavily API ${res.status}`);

  const data = (await res.json()) as {
    results: { title: string; url: string; content: string }[];
  };
  return data.results.map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.content,
  }));
}

async function ddgSearch(query: string, maxResults: number): Promise<SearchResult[]> {
  const res = await fetch(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    { headers: { "User-Agent": "MineClaw/1.0" } },
  );
  if (!res.ok) throw new Error(`DuckDuckGo ${res.status}`);

  const html = await res.text();
  const results: SearchResult[] = [];
  const re =
    /<a[^>]+class="result__a"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && results.length < maxResults) {
    results.push({
      title: strip(m[2]),
      url: decodeURIComponent(m[1].replace(/.*uddg=/, "").replace(/&.*/, "")),
      snippet: strip(m[3]),
    });
  }
  return results;
}

function strip(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

export default {
  name: "web_search",
  description:
    "Search the web for information. Returns titles, URLs, and snippets. " +
    "Uses Tavily API when TAVILY_API_KEY is set, falls back to DuckDuckGo.",
  input_schema: {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "Search query" },
      max_results: {
        type: "number",
        description: "Maximum number of results (default: 5)",
      },
    },
    required: ["query"],
  },
  async execute(args) {
    const query = String(args.query);
    const maxResults = Number(args.max_results ?? 5);

    try {
      return JSON.stringify({ results: await tavilySearch(query, maxResults) });
    } catch {
      try {
        return JSON.stringify({ results: await ddgSearch(query, maxResults) });
      } catch (e) {
        return JSON.stringify({
          error: `Search failed: ${(e as Error).message}`,
        });
      }
    }
  },
} satisfies ToolDefinition;
