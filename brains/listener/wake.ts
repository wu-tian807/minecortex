/** @desc listener 唤醒策略: 只被 stdin 事件唤醒 */

import type { WakePolicy } from "../../src/core/types.js";

export default {
  shouldWake(notice) {
    return notice.kind === "event" && notice.event?.source === "stdin";
  },
} satisfies WakePolicy;
