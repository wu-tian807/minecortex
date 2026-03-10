import type { SlotFactory } from "../src/context/types.js";
import { SkillsLoader } from "./lib/skills-loader.js";

const loader = new SkillsLoader();

/**
 * skills slot 工厂。
 * 激活路径：Scheduler → SlotLoader → slots/skills.ts → SkillsLoader.createSummarySlot()
 * createSummarySlot 内的 content() 懒加载，每次调用时重新扫描两层目录。
 */
const create: SlotFactory = (ctx) =>
  loader.createSummarySlot(ctx.pathManager, ctx.brainId);

export default create;
