/** @desc 指令: 工具使用纪律 */

import type { DirectiveConfig } from "../src/core/types.js";

export const directive: DirectiveConfig = {
  name: "tool-usage-policy",
  order: 1,
  condition: (ctx) => ctx.hasTools,
};
