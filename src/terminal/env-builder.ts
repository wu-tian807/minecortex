/**
 * env-builder — 为 brain shell 进程构建完整的运行时环境变量。
 *
 * 优先级（低 → 高）：
 *   宿主机安全子集 < bundle/shared/env/base.env < brain .env < per-call extraEnv
 *
 * PATH 构建（高→低）：
 *   1. <BRAIN_DIR>/.local/bin      — pipx / pip install --user 安装的命令
 *   2. <PYTHON_HOME>/bin           — bundle 独立 Python（python3/pip3）
 *   3. <NODE_HOME>/bin             — bundle 独立 Node.js（node/npm/npx）
 *   4. /usr/local/bin              — namespace overlay 后可用的自编译工具
 *   5. 宿主机 PATH                 — 基础系统工具
 */

import { readFile } from "node:fs/promises";
import type { PathManagerAPI } from "../core/types.js";

// 从宿主机 env 白名单中保留的安全 key
const SAFE_HOST_KEYS = [
  "HOME", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "LC_ALL", "LC_CTYPE",
  "TZ", "DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS",
  "PATH",
];

/**
 * 解析 .env 文件内容为 key-value 对。
 * 支持：注释行（#）、单双引号值、KEY=VALUE 格式。
 * 不支持：多行值、$VAR 展开（路径变量由代码逻辑处理）。
 */
export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    // 去掉首尾引号
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key) result[key] = val;
  }
  return result;
}

/** 从宿主机 process.env 中只取安全白名单的 key */
function pickSafeHostEnv(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of SAFE_HOST_KEYS) {
    if (process.env[key] !== undefined) result[key] = process.env[key];
  }
  return result;
}

  /**
   * 为指定 brain 构建完整的 shell 进程 env。
   *
   * 读取顺序（低→高优先级）：
   *   1. 宿主机安全子集（USER、PATH 等）
   *   2. bundle/shared/env/base.env（PYTHON_HOME、NODE_HOME 等，框架生成）
   *   3. bundle/brains/{brainId}/.env（brain 级私有，类 .bashrc，用户编辑，仅非系统终端时读取）
   *   4. extraEnv（per-call 覆盖）
   *
   * @param brainId       brain 标识符（传空或 undefined 则为系统级环境，不读取私有 .env）
   * @param pathManager   路径管理器
   * @param useNamespace  是否在 namespace 中运行（true → HOME 重映射到 BRAIN_DIR 或 系统 root_home）
   * @param extraEnv      调用时传入的临时覆盖
   */
  export async function buildBrainShellEnv(
    brainId: string | undefined,
    pathManager: PathManagerAPI,
    useNamespace = false,
    extraEnv?: Record<string, string>,
  ): Promise<NodeJS.ProcessEnv> {
    const isSystem = !brainId;
    const safeHost = pickSafeHostEnv();
  
    // 读取 bundle 级 base.env（框架自动生成，包含 PYTHON_HOME/NODE_HOME 等）
    const baseEnvPath = pathManager.bundle().sharedDir() + "/env/base.env";
    let baseEnv: Record<string, string> = {};
    try {
      const content = await readFile(baseEnvPath, "utf-8");
      baseEnv = parseEnvFile(content);
    } catch { /* base.env 不存在则跳过 */ }
  
    let brainDotEnv: Record<string, string> = {};
    let brainDir = "";
  
    // 只有非 system 终端才加载 brain 自己的 .env 和设置 brainDir
    if (!isSystem && brainId) {
      brainDir = pathManager.local(brainId).root();
      const brainEnvPath = brainDir + "/.env";
      try {
        const content = await readFile(brainEnvPath, "utf-8");
        brainDotEnv = parseEnvFile(content);
      } catch { /* .env 不存在则跳过 */ }
    } else {
      brainDir = pathManager.bundle().root();
    }
  
    // 合并（低→高优先级）
    const merged: NodeJS.ProcessEnv = {
      ...safeHost,
      ...baseEnv,
      ...brainDotEnv,
      ...(extraEnv ?? {}),
      BRAIN_ID:  brainId ?? "",
      BRAIN_DIR: brainDir,
    };
  
    // HOME 重映射：namespace 内将 HOME 指向 private 目录或 system root_home
    if (useNamespace) {
      merged.HOME = isSystem
        ? pathManager.bundle().sharedDir() + "/.root_home"
        : pathManager.local(brainId).homeDir();
    }
  
    // PATH 构建（高→低优先级）
    const pythonBin = merged.PYTHON_HOME ? `${merged.PYTHON_HOME}/bin` : null;
    const nodeBin   = merged.NODE_HOME   ? `${merged.NODE_HOME}/bin`   : null;
    const hostPath  = safeHost.PATH ?? "/usr/bin:/bin";
  
    merged.PATH = [
      useNamespace ? `${merged.HOME}/.local/bin` : `${brainDir}/.local/bin`, // pipx / pip install --user 命令
      pythonBin,                  // bundle 独立 python3/pip3 (若有)
      nodeBin,                    // bundle 独立 node/npm/npx (若有)
      "/usr/local/bin",           // overlay 后可用的标准系统自编译工具
      hostPath,                   // 宿主机基础工具
    ].filter(Boolean).join(":");
  
    return merged;
  }
