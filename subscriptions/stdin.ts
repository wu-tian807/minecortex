/** @desc 可插拔事件源: 监听 stdin 终端输入，每行产生一个 Event */

import * as readline from "node:readline";
import type { Event, EventSource } from "../src/core/types.js";

let rl: readline.Interface | null = null;

export default {
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
} satisfies EventSource;
