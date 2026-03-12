import { isAbsolute, resolve } from "node:path";
import type { BrainBoardAPI, BrainJson, PathManagerAPI } from "../core/types.js";

export const BRAINBOARD_KEYS = {
  BRAIN_ID: "BRAIN_ID",
  BRAIN_DIR: "BRAIN_DIR",
  HOME_DIR: "HOME_DIR",
  SHARED_WORKSPACE: "SHARED_WORKSPACE",
  CURRENT_DIR: "currentDir",
  CURRENT_TIME: "CURRENT_TIME",
  ACTIVE_TOOLS: "ACTIVE_TOOLS",
  CURRENT_CONTEXT_USAGE: "currentContextUsage",
} as const;

export const BUILTIN_BRAINBOARD_VARS = [
  { key: BRAINBOARD_KEYS.BRAIN_ID, persisted: false, description: "Current brain id." },
  { key: BRAINBOARD_KEYS.BRAIN_DIR, persisted: false, description: "Current brain config directory." },
  { key: BRAINBOARD_KEYS.HOME_DIR, persisted: false, description: "Current brain private .home directory." },
  { key: BRAINBOARD_KEYS.SHARED_WORKSPACE, persisted: false, description: "Bundle shared workspace directory." },
  { key: BRAINBOARD_KEYS.CURRENT_DIR, persisted: false, description: "Current focused working directory used by shell/context slots; initialized from brain.json.defaultDir or HOME_DIR." },
  { key: BRAINBOARD_KEYS.CURRENT_TIME, persisted: false, description: "Wall-clock time refreshed before each prompt assembly." },
  { key: BRAINBOARD_KEYS.ACTIVE_TOOLS, persisted: false, description: "Active tool metadata rendered by the tools slot." },
  { key: BRAINBOARD_KEYS.CURRENT_CONTEXT_USAGE, persisted: true, description: "Current session token usage snapshot." },
] as const;

export function resolveBrainDefaultDir(
  brainId: string,
  brainJson: BrainJson,
  pathManager: PathManagerAPI,
): string {
  const homeDir = pathManager.local(brainId).homeDir();
  const rawDefault = brainJson.defaultDir;
  if (!rawDefault) return homeDir;
  return isAbsolute(rawDefault) ? rawDefault : resolve(homeDir, rawDefault);
}

export function buildBuiltinBrainBoardVars(
  brainId: string,
  brainDir: string,
  pathManager: PathManagerAPI,
): Record<string, string> {
  const homeDir = pathManager.local(brainId).homeDir();
  const sharedWorkspace = pathManager.bundle().sharedWorkspace();

  return {
    [BRAINBOARD_KEYS.BRAIN_ID]: brainId,
    [BRAINBOARD_KEYS.BRAIN_DIR]: brainDir,
    [BRAINBOARD_KEYS.HOME_DIR]: homeDir,
    [BRAINBOARD_KEYS.SHARED_WORKSPACE]: sharedWorkspace,
  };
}

export function createCurrentDirPathManager(
  pathManager: PathManagerAPI,
  brainBoard: BrainBoardAPI,
  brainId: string,
): PathManagerAPI {
  const wrapper = Object.create(pathManager) as PathManagerAPI;
  wrapper.resolve = (input, callerBrainId) => {
    const raw = input.path;
    if (isAbsolute(raw)) return pathManager.resolve(input, callerBrainId);

    const baseDir = brainBoard.get(brainId, BRAINBOARD_KEYS.CURRENT_DIR) as string | undefined;
    if (!baseDir) return pathManager.resolve(input, callerBrainId);

    return resolve(baseDir, raw);
  };
  return wrapper;
}
