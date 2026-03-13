import { watch as watchFs, type FSWatcher } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PathManagerAPI } from "../core/types.js";

export interface SessionPointerJson {
  currentSessionId?: string;
  [key: string]: unknown;
}

export function sessionPointerPath(pathManager: PathManagerAPI, brainId: string): string {
  return join(pathManager.local(brainId).root(), "session.json");
}

export async function readSessionPointerJson(
  pathManager: PathManagerAPI,
  brainId: string,
): Promise<SessionPointerJson | null> {
  try {
    const raw = await readFile(sessionPointerPath(pathManager, brainId), "utf-8");
    return JSON.parse(raw) as SessionPointerJson;
  } catch {
    return null;
  }
}

export async function readCurrentSessionId(
  pathManager: PathManagerAPI,
  brainId: string,
): Promise<string | null> {
  const data = await readSessionPointerJson(pathManager, brainId);
  return data?.currentSessionId ?? null;
}

export async function writeSessionPointerJson(
  pathManager: PathManagerAPI,
  brainId: string,
  data: SessionPointerJson,
): Promise<void> {
  const path = sessionPointerPath(pathManager, brainId);
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, JSON.stringify(data, null, 2));
  await rename(tempPath, path);
}

export async function writeCurrentSessionId(
  pathManager: PathManagerAPI,
  brainId: string,
  sessionId: string,
): Promise<void> {
  const existing = (await readSessionPointerJson(pathManager, brainId)) ?? {};
  await writeSessionPointerJson(pathManager, brainId, {
    ...existing,
    currentSessionId: sessionId,
  });
}

export async function updateSessionPointerMeta(
  pathManager: PathManagerAPI,
  brainId: string,
  updates: Record<string, unknown>,
): Promise<void> {
  const existing = (await readSessionPointerJson(pathManager, brainId)) ?? {};
  await writeSessionPointerJson(pathManager, brainId, {
    ...existing,
    ...updates,
  });
}

export function watchCurrentSessionId(params: {
  pathManager: PathManagerAPI;
  brainId: string;
  onChange: (sessionId: string) => void;
  initialSessionId?: string | null;
  debounceMs?: number;
}): FSWatcher | null {
  const { pathManager, brainId, onChange, debounceMs = 100 } = params;
  const path = sessionPointerPath(pathManager, brainId);
  let lastSeen = params.initialSessionId ?? null;
  let debounce: ReturnType<typeof setTimeout> | null = null;

  try {
    return watchFs(path, { persistent: false }, () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(async () => {
        const nextId = await readCurrentSessionId(pathManager, brainId).catch(() => null);
        if (!nextId || nextId === lastSeen) return;
        lastSeen = nextId;
        onChange(nextId);
      }, debounceMs);
    });
  } catch {
    return null;
  }
}
