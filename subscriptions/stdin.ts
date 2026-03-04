/** @desc Stdin subscription — terminal input as EventSource */

import * as readline from "node:readline";
import type { Event, EventSource, SourceContext } from "../src/core/types.js";
import { parseCommand } from "../src/core/command-parser.js";

export default function create(ctx: SourceContext): EventSource {
  let rl: readline.Interface | null = null;

  return {
    name: "stdin",

    start(emit: (event: Event) => void) {
      rl = readline.createInterface({ input: process.stdin });

      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (trimmed.length === 0) return;

        if (trimmed.startsWith("/")) {
          const cmd = parseCommand(trimmed);
          if (cmd) {
            ctx.brain.queueCommand(cmd.toolName, cmd.args);
            return;
          }
        }

        emit({
          source: "stdin",
          type: "user_input",
          payload: { text: trimmed },
          ts: Date.now(),
        });
      });

      rl.on("close", () => {
        rl = null;
      });
    },

    stop() {
      rl?.close();
      rl = null;
    },
  };
}
