/** @desc Overlay helpers — brain/session selector TUI screens */

import { C } from "./ansi.js";
import { listBrainIds, listSessionIds } from "./fs-helpers.js";
import { SelectOverlay } from "./select-overlay.js";
import { SessionManager } from "../session/session-manager.js";
import { getPathManager } from "../fs/index.js";

/** Minimal interface that the two show-overlay helpers need from CLIRenderer. */
export interface OverlayHost {
  readonly activeBrain:   string;
  readonly activeSession: string;
  print(text: string): void;
  openOverlay(ov: SelectOverlay, onConfirm: (idx: number) => Promise<void>): void;
  switchTo(brainId: string, sessionId: string): Promise<void>;
}

export async function showBrainsOverlay(host: OverlayHost): Promise<void> {
  const ids = await listBrainIds();
  if (!ids.length) { host.print(`${C.dim}没有可用的 brain${C.reset}\n`); return; }
  const items = ids.map(id => ({
    label: id,
    hint:  id === host.activeBrain ? "(active)" : undefined,
  }));
  host.openOverlay(
    new SelectOverlay("brains", items, Math.max(0, ids.indexOf(host.activeBrain))),
    async (idx) => { await showSessionsOverlay(host, ids[idx]); },
  );
}

export async function showSessionsOverlay(host: OverlayHost, brainId?: string): Promise<void> {
  const targetBrain = brainId ?? host.activeBrain;
  if (!targetBrain) { host.print(`${C.dim}未指定 brain${C.reset}\n`); return; }
  const sessions = await listSessionIds(targetBrain);

  const items = sessions.map(sid => ({
    label: sid,
    hint:  targetBrain === host.activeBrain && sid === host.activeSession ? "(active)" : undefined,
  }));
  items.push({ label: "+ New Session", hint: undefined });

  const activeIdx = sessions.indexOf(host.activeSession);
  host.openOverlay(
    new SelectOverlay(`${targetBrain} sessions`, items, Math.max(0, activeIdx)),
    async (idx) => {
      if (idx === sessions.length) {
        const sm = new SessionManager(targetBrain, getPathManager());
        const newSid = await sm.createSession();
        host.print(`${C.dim}新建 session: ${targetBrain} / ${newSid}${C.reset}\n`);
        await host.switchTo(targetBrain, newSid);
      } else {
        const sid = sessions[idx];
        if (sid) {
          host.print(`${C.dim}切换到 ${targetBrain} / ${sid}${C.reset}\n`);
          await host.switchTo(targetBrain, sid);
        }
      }
    },
  );
}
