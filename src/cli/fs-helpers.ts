/** @desc Filesystem helpers for brain/session discovery (no scheduler dependency) */

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export async function listBrainIds(rootDir: string): Promise<string[]> {
  try {
    const brainsDir = join(rootDir, "brains");
    const entries = await readdir(brainsDir, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory() && existsSync(join(brainsDir, e.name, "brain.json")))
      .map(e => e.name);
  } catch {
    return [];
  }
}

export async function listSessionIds(rootDir: string, brainId: string): Promise<string[]> {
  try {
    const sessionsDir = join(rootDir, "brains", brainId, "sessions");
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
