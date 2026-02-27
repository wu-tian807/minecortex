/** @desc responder 唤醒策略: 只被 BrainBus 消息唤醒 */

import type { WakePolicy } from "../../src/core/types.js";

export default {
  shouldWake(notice) {
    return notice.kind === "bus";
  },
} satisfies WakePolicy;
