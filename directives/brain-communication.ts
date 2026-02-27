/** @desc 指令: 脑间通信规则 */

import type { DirectiveConfig } from "../src/core/types.js";

export const directive: DirectiveConfig = {
  name: "brain-communication",
  order: 2,
  condition: (ctx) => ctx.hasTools,
};
