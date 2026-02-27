/** @desc Stdin subscription source — terminal input as standard EventSource */

import * as readline from "node:readline";
import type { Event, EventSource, SourceContext } from "../src/core/types.js";

export default function create(_ctx: SourceContext): EventSource {
  let rl: readline.Interface | null = null;

  return {
    name: "stdin",

    start(emit: (event: Event) => void) {
      rl = readline.createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        if (line.trim().length === 0) return;
        emit({
          source: "stdin",
          type: "message",
          payload: { text: line.trim() },
          ts: Date.now(),
        });
      });
      console.log("[stdin] 订阅已启动，等待输入...");
    },

    stop() {
      rl?.close();
      rl = null;
    },
  };
}
