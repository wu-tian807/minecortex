/**
 * bundle 环境初始化 — 由 BundleManager.init() 调用一次（幂等）。
 *
 * 职责：
 *   1. 确保 bundle 级独立 Python 存在（下载 python-build-standalone）
 *      → 安装到 bundle/shared/runtime/python/（不写 /usr/local，绕开 overlay copy-up 问题）
 *   2. 确保 bundle 级独立 Node.js 存在（下载官方预编译包）
 *      → 安装到 bundle/shared/runtime/node/
 *   3. 写入 base.env：PYTHON_HOME / NODE_HOME / LD_LIBRARY_PATH / PKG_CONFIG_PATH
 *   4. 确保 bundle 级 npm 工作目录存在
 */

import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getTerminalManager } from "../terminal/manager.js";

// ─── Python build-standalone config ───────────────────────────────────────────

const PBS_TAG     = "20260303";
const PBS_VERSION = "3.12.13";
const PBS_ARCH    = "x86_64-unknown-linux-gnu";
const PBS_ASSET   = `cpython-${PBS_VERSION}+${PBS_TAG}-${PBS_ARCH}-install_only.tar.gz`;
const PBS_URL     = `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/${PBS_ASSET}`;

// ─── Node.js LTS config ────────────────────────────────────────────────────────

const NODE_VERSION = "v24.14.0";
const NODE_ASSET   = `node-${NODE_VERSION}-linux-x64.tar.gz`;
const NODE_URL     = `https://nodejs.org/dist/${NODE_VERSION}/${NODE_ASSET}`;
// dir inside the tarball (e.g. node-v24.14.0-linux-x64/)
const NODE_DIR     = `node-${NODE_VERSION}-linux-x64`;

// ─── Public entry ─────────────────────────────────────────────────────────────

export async function ensureBundleEnvironment(
  bundleRoot: string,
  manifest: any,
  saveManifest: () => Promise<void>,
  onProgress?: (msg: string) => void,
): Promise<void> {
  const log = onProgress ?? ((m: string) => console.log(m));
  await ensurePython(bundleRoot, log, manifest, saveManifest);
  await ensureNode(bundleRoot, log, manifest, saveManifest);
  await ensureNodeLib(bundleRoot);
  // base.env 由 BundleManager.initBaseEnv() 生成（在本函数调用完毕后执行），
  // 内含 PYTHON_HOME / NODE_HOME 等路径。setup.sh 可在此基础上追加自定义变量。
}

// ─── Python (python-build-standalone) ─────────────────────────────────────────

async function ensurePython(
  bundleRoot: string,
  log: (msg: string) => void,
  manifest: any,
  saveManifest: () => Promise<void>
): Promise<void> {
  if (manifest.runtimeState.pythonInstalled) return;

  // Install to bundle-local path to avoid overlayfs copy-up issues in user namespaces.
  // The host's /usr/local/bin may already contain Python files; overwriting them through
  // an overlay triggers file copy-up which fails with EACCES.
  const pythonDest = join(bundleRoot, "shared", "runtime", "python");
  log("[bundle] 独立 Python 不存在，开始下载并安装...");
  log(`[bundle] 下载源: ${PBS_URL}`);
  log(`[bundle] 安装目标: ${pythonDest}`);

  const tm = getTerminalManager();

  const script = `
    set -e
    mkdir -p '${pythonDest}'
    mkdir -p /tmp/python-dl
    cd /tmp/python-dl
    curl -L --retry 3 --max-time 300 --progress-bar "${PBS_URL}" -o python.tar.gz
    tar -xzf python.tar.gz
    # The extracted folder is 'python'
    cp -a python/. '${pythonDest}/'
    rm -rf /tmp/python-dl
  `;

  const res = await tm.exec(script, { timeoutMs: 0, description: "install-python" });
  if (res.exitCode !== 0) {
    const tail = res.stdout?.trim().split("\n").slice(-8).join("\n") ?? "";
    throw new Error(`Failed to install Python (exit ${res.exitCode}):\n${tail}\n→ full log: ${res.logFile}`);
  }

  log(`[bundle] Python 就绪: ${pythonDest}/bin/python3`);
  manifest.runtimeState.pythonInstalled = true;
  await saveManifest();
}

// ─── Node.js ──────────────────────────────────────────────────────────────────

async function ensureNode(
  bundleRoot: string,
  log: (msg: string) => void,
  manifest: any,
  saveManifest: () => Promise<void>
): Promise<void> {
  if (manifest.runtimeState.nodeInstalled) return;

  // Same rationale as ensurePython — install to bundle-local path.
  const nodeDest = join(bundleRoot, "shared", "runtime", "node");
  log("[bundle] 独立 Node.js 不存在，开始下载并安装...");
  log(`[bundle] 下载源: ${NODE_URL}`);
  log(`[bundle] 安装目标: ${nodeDest}`);

  const tm = getTerminalManager();

  const script = `
    set -e
    mkdir -p '${nodeDest}'
    mkdir -p /tmp/node-dl
    cd /tmp/node-dl
    curl -L --retry 3 --max-time 300 --progress-bar "${NODE_URL}" -o node.tar.gz
    tar --no-same-owner -xzf node.tar.gz
    cp -a ${NODE_DIR}/. '${nodeDest}/'
    rm -rf /tmp/node-dl
  `;

  const res = await tm.exec(script, { timeoutMs: 0, description: "install-node" });
  if (res.exitCode !== 0) {
    const tail = res.stdout?.trim().split("\n").slice(-8).join("\n") ?? "";
    throw new Error(`Failed to install Node.js (exit ${res.exitCode}):\n${tail}\n→ full log: ${res.logFile}`);
  }

  log(`[bundle] Node.js 就绪: ${nodeDest}/bin/node`);
  manifest.runtimeState.nodeInstalled = true;
  await saveManifest();
}

// ─── Node lib 目录（bundle 级 node_modules）──────────────────────────────────

async function ensureNodeLib(bundleRoot: string): Promise<void> {
  const libPath = join(bundleRoot, "shared/lib");
  const pkgPath = join(libPath, "package.json");
  const nmPath  = join(libPath, "node_modules");

  await mkdir(libPath, { recursive: true });
  await mkdir(nmPath,  { recursive: true });

  if (!existsSync(pkgPath)) {
    await writeFile(
      pkgPath,
      JSON.stringify(
        { name: "bundle-shared", private: true, description: "bundle 级共享 npm 包", dependencies: {} },
        null, 2,
      ) + "\n",
      "utf-8",
    );
  }
}
