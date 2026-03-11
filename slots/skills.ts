import type { SlotFactory } from "../src/context/types.js";
import { createSkillsSummarySlot } from "./lib/skills-loader.js";

/**
 * skills slot 工厂。
 * 激活路径：Scheduler → SlotLoader → slots/skills.ts → 自定义扫盘逻辑。
 */
const create: SlotFactory = (ctx) =>
  createSkillsSummarySlot(ctx.pathManager, ctx.brainId);

export default create;
