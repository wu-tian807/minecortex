/** @desc Filesystem helpers for brain/session discovery (no scheduler dependency) */

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { getPathManager } from "../fs/index.js";

export async function listBrainIds(): Promise<string[]> {
  try {
    const brainsDir = getPathManager().bundle().brainsDir();
    const entries = await readdir(brainsDir, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory() && existsSync(join(brainsDir, e.name, "brain.json")))
      .map(e => e.name);
  } catch {
    return [];
  }
}

export async function listSessionIds(brainId: string): Promise<string[]> {
  try {
    const sessionsDir = getPathManager().local(brainId).sessionsDir();
    const entries = await readdir(sessionsDir, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}
