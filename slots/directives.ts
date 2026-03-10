import type { SlotFactory } from "../src/context/types.js";
import { DirectivesLoader } from "./lib/directives-loader.js";

const loader = new DirectivesLoader();

/**
 * directives slot 工厂。
 * 激活路径：Scheduler → SlotLoader → slots/directives.ts → DirectivesLoader.scanSync()
 * loader 实例在工厂函数外共享（registry 按需复用），content() 仍然懒加载。
 */
const create: SlotFactory = (ctx) =>
  loader.scanSync(ctx.pathManager, ctx.brainId).flat();

export default create;
