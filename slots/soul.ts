import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SlotFactory } from "../src/context/types.js";

const create: SlotFactory = (ctx) => ({
  id: "soul",
  order: 1,
  priority: 10,
  content: () => {
    try {
      return readFileSync(join(ctx.pathManager.local(ctx.brainId).root(), "soul.md"), "utf-8");
    } catch {
      return "";
    }
  },
  version: 0,
});

export default create;
