import type { SlotFactory } from "../src/context/types.js";
import type { SlotWatchFactory } from "../src/loaders/types.js";
import { createDirectiveSlots } from "./lib/directives-loader.js";
import { buildDirectiveWatchPatterns } from "./lib/directives-loader.js";

/**
 * directives slot 工厂。
 * 激活路径：Scheduler → SlotLoader → slots/directives.ts → 自定义扫盘逻辑。
 */
const create: SlotFactory = (ctx) =>
  createDirectiveSlots(ctx.pathManager, ctx.brainId);

export const watch: SlotWatchFactory = (ctx) =>
  buildDirectiveWatchPatterns(ctx.pathManager, ctx.brainId);

export default create;
