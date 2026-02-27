/** @desc 工具: 读取其他脑的 state.json */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolDefinition } from "../src/core/types.js";

export default {
  name: "read_state",
  description:
    "Read another brain's state.json to see its current working memory. " +
    "Use this to understand what another brain is doing before sending it a message.",
  parameters: {
    brain_id: { type: "string", description: "The brain ID whose state to read (e.g. 'listener')", required: true },
  },
  async execute(args) {
    const brainId = args.brain_id as string;
    const path = join(process.cwd(), "brains", brainId, "state.json");
    try {
      const raw = await readFile(path, "utf-8");
      return JSON.parse(raw);
    } catch {
      return { error: `Cannot read state for brain '${brainId}'` };
    }
  },
} satisfies ToolDefinition;
