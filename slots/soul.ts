import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SlotFactory, ContextSlot } from "../src/context/types.js";

const ROOT = process.cwd();

const create: SlotFactory = (ctx): ContextSlot => {
  const soulPath = join(ROOT, "brains", ctx.brainId, "soul.md");

  return {
    id: "soul",
    order: 1,
    priority: 10,
    content: () => {
      try {
        return readFileSync(soulPath, "utf-8");
      } catch {
        return "";
      }
    },
    version: 0,
  };
};

export default create;
