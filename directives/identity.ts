/** @desc 指令: 运行时身份信息 */

import type { DirectiveConfig } from "../src/core/types.js";

export const directive: DirectiveConfig = {
  name: "identity",
  order: 0,
  variables: ["BRAIN_ID", "MODEL", "TIMESTAMP"],
};
