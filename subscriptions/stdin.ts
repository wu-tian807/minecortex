/** @desc Stdin subscription source — terminal input as standard EventSource */

import * as readline from "node:readline";
import { join } from "node:path";
import type { Event, EventSource, SourceContext } from "../src/core/types.js";
import { parseCommand } from "../src/core/command-parser.js";
import { QARecorder } from "../src/session/qa-recorder.js";

export default function create(ctx: SourceContext): EventSource {
  let rl: readline.Interface | null = null;
  const qa = new QARecorder(join(ctx.brainDir, "logs"));

  return {
    name: "stdin",

    start(emit: (event: Event) => void) {
      rl = readline.createInterface({ input: process.stdin });

      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (trimmed.length === 0) return;

        if (trimmed.startsWith("/")) {
          const cmd = parseCommand(trimmed);
          if (cmd && ctx.onCommand) {
            ctx.onCommand(cmd.toolName, cmd.args, cmd.target);
            return;
          }
        }

        qa.recordUser(trimmed).catch(() => {});

        emit({
          source: "stdin",
          type: "message",
          payload: { text: trimmed },
          ts: Date.now(),
        });
      });

      rl.on("close", () => {
        console.log("[stdin] 输入流已关闭");
        rl = null;
      });

      console.log("[stdin] 订阅已启动，等待输入...");
    },

    stop() {
      rl?.close();
      rl = null;
      qa.close();
    },
  };
}
