/** @desc CLI subscription — terminal input as EventSource
 *
 *  In TTY mode the CLIRenderer owns stdin (raw mode) and broadcasts user_input
 *  to all brains via EventBus.  This subscription only creates its own readline
 *  in non-TTY (piped) mode as a fallback. */

import * as readline from "node:readline";
import type { Event, EventSource, SubscriptionContext } from "../src/core/types.js";
import { parseCommand } from "../src/core/command-parser.js";

export default function create(ctx: SubscriptionContext): EventSource {
  let rl: readline.Interface | null = null;

  return {
    name: "cli",

    start(emit: (event: Event) => void) {
      if (process.stdin.isTTY) return;

      rl = readline.createInterface({ input: process.stdin });

      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (trimmed.length === 0) return;

        if (trimmed.startsWith("/")) {
          const cmd = parseCommand(trimmed);
          if (cmd) {
            ctx.queueCommand?.(cmd.toolName, cmd.args);
            return;
          }
        }

        emit({
          source: "cli",
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
