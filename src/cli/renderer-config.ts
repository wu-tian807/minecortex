/** @desc RendererConfig — state persistence and active brain/session resolution */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getPathManager } from "../fs/index.js";
import { listBrainIds, listSessionIds } from "./fs-helpers.js";

interface RendererStateJson {
  activeBrain?: string;
  [key: string]: unknown;
}

export interface ResolvedContext {
  brain: string;
  session: string;
  /** True when no valid brain was found — caller should show the brains overlay. */
  needsSelection: boolean;
}

export class RendererConfig {
  constructor() {}

  // ─── App config (bundle/state/renderer.json) ───

  private get rendererStatePath(): string {
    return join(getPathManager().bundle().stateDir(), "renderer.json");
  }

  read(): RendererStateJson {
    try { 
      const path = this.rendererStatePath;
      if (!existsSync(path)) return {};
      return JSON.parse(readFileSync(path, "utf-8")) as RendererStateJson; 
    } catch { 
      return {}; 
    }
  }

  async writeActiveBrain(brain: string): Promise<void> {
    const statePath = this.rendererStatePath;
    const cfg = this.read();
    
    mkdirSync(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({ ...cfg, activeBrain: brain }, null, 2));
  }

  // ─── Per-brain session.json ───

  readSession(brainId: string): string {
    try {
      const path = join(getPathManager().local(brainId).root(), "session.json");
      const data = JSON.parse(readFileSync(path, "utf-8")) as { currentSessionId?: string };
      return data.currentSessionId ?? "";
    } catch { return ""; }
  }

  async writeSession(brainId: string, sessionId: string): Promise<void> {
    const path = join(getPathManager().local(brainId).root(), "session.json");
    try {
      let data: Record<string, unknown> = {};
      try { data = JSON.parse(readFileSync(path, "utf-8")); } catch { /* fresh */ }
      data.currentSessionId = sessionId;
      await writeFile(path, JSON.stringify(data, null, 2));
    } catch { /* ignore */ }
  }

  // ─── Resolve active brain + session on startup ───

  async resolveActive(): Promise<ResolvedContext> {
    const brain    = this.read().activeBrain ?? "";
    const brainIds = await listBrainIds();

    if (!brain || !brainIds.includes(brain)) {
      return { brain: "", session: "", needsSelection: true };
    }

    const session  = this.readSession(brain);
    const sessions = await listSessionIds(brain);
    return {
      brain,
      session: (session && sessions.includes(session)) ? session : (sessions[0] ?? ""),
      needsSelection: false,
    };
  }
}
