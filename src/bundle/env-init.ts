/**
 * bundle 环境初始化 — 由 TerminalManager.init() 调用一次（幂等）。
 *
 * 职责：
 *   1. 确保 bundle 级独立 Python 存在（下载 python-build-standalone，不依赖宿主机 python）
 *   2. 确保 bundle 级独立 Node.js 存在（下载官方预编译包，不依赖宿主机 node）
 *   3. 确保 bundle 级 npm 工作目录存在
 *   4. 生成 bundle/shared/env/base.env（路径是绝对路径，每次启动刷新）
 */

import { mkdir, writeFile, rename, rm } from "node:fs/promises";
import { existsSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { exec as execCb, spawn } from "node:child_process";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

const execAsync = promisify(execCb);

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
  onProgress?: (msg: string) => void,
): Promise<void> {
  const log = onProgress ?? ((m: string) => console.log(m));
  await ensurePython(bundleRoot, log);
  await ensureNode(bundleRoot, log);
  await ensureNodeLib(bundleRoot);
  await generateBaseEnv(bundleRoot);
}

// ─── Python (python-build-standalone) ─────────────────────────────────────────

async function ensurePython(
  bundleRoot: string,
  log: (msg: string) => void,
): Promise<void> {
  const pythonHome = join(bundleRoot, "shared/lib/python");
  const sentinel   = join(pythonHome, "bin/python3");

  if (existsSync(sentinel)) return;

  log("[bundle] 独立 Python 不存在，开始下载（首次运行，约需 1-2 分钟）...");
  log(`[bundle] 下载源: ${PBS_URL}`);

  const tmpTar = join(bundleRoot, "shared/lib/.python-download.tar.gz");
  const tmpDir = join(bundleRoot, "shared/lib/.python-unpack");

  await mkdir(join(bundleRoot, "shared/lib"), { recursive: true });

  try {
    await downloadFile(PBS_URL, tmpTar, (pct) => {
      if (pct % 20 === 0) log(`[bundle] Python 下载 ${pct}%...`);
    });

    log("[bundle] 解压 Python...");
    await extractTarGz(tmpTar, tmpDir);

    // python-build-standalone 解压后是 python/ 子目录
    const extractedPython = join(tmpDir, "python");
    if (!existsSync(extractedPython)) {
      throw new Error(`解压后未找到 python/ 目录，内容: ${await listDir(tmpDir)}`);
    }
    await rename(extractedPython, pythonHome);
    log(`[bundle] Python 就绪: ${pythonHome}`);
  } finally {
    await rm(tmpTar, { force: true });
    await rm(tmpDir, { recursive: true, force: true });
  }
}

// ─── Node.js ──────────────────────────────────────────────────────────────────

async function ensureNode(
  bundleRoot: string,
  log: (msg: string) => void,
): Promise<void> {
  const nodeHome = join(bundleRoot, "shared/lib/node");
  const sentinel = join(nodeHome, "bin/node");

  if (existsSync(sentinel)) return;

  log("[bundle] 独立 Node.js 不存在，开始下载（首次运行）...");
  log(`[bundle] 下载源: ${NODE_URL}`);

  const tmpTar = join(bundleRoot, "shared/lib/.node-download.tar.gz");
  const tmpDir = join(bundleRoot, "shared/lib/.node-unpack");

  await mkdir(join(bundleRoot, "shared/lib"), { recursive: true });

  try {
    await downloadFile(NODE_URL, tmpTar, (pct) => {
      if (pct % 20 === 0) log(`[bundle] Node.js 下载 ${pct}%...`);
    });

    log("[bundle] 解压 Node.js...");
    await extractTarGz(tmpTar, tmpDir);

    const extractedNode = join(tmpDir, NODE_DIR);
    if (!existsSync(extractedNode)) {
      throw new Error(`解压后未找到 ${NODE_DIR}/ 目录，内容: ${await listDir(tmpDir)}`);
    }
    await rename(extractedNode, nodeHome);
    log(`[bundle] Node.js 就绪: ${nodeHome}`);
  } finally {
    await rm(tmpTar, { force: true });
    await rm(tmpDir, { recursive: true, force: true });
  }
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

// ─── base.env 生成 ────────────────────────────────────────────────────────────

/**
 * 每次框架启动时重新生成 base.env（路径是绝对路径，随 bundleRoot 而定）。
 * brain 级 .env 优先级高于此文件，可覆盖任意变量。
 */
async function generateBaseEnv(bundleRoot: string): Promise<void> {
  const envDir  = join(bundleRoot, "shared/env");
  const envPath = join(envDir, "base.env");
  await mkdir(envDir, { recursive: true });

  const pythonHome    = join(bundleRoot, "shared/lib/python");
  const nodeHome      = join(bundleRoot, "shared/lib/node");
  const nmPath        = join(bundleRoot, "shared/lib/node_modules");
  const browsersPath  = join(bundleRoot, "shared/browsers");
  const bundleLibPath = join(bundleRoot, "shared/lib");

  const lines = [
    "# bundle/shared/env/base.env",
    "# 由框架自动生成（每次启动时刷新），手动修改会被覆盖。",
    "# 要自定义 brain 级 env，请编辑 bundle/brains/{brainId}/.env",
    "",
    "# ─── Python（bundle 级独立安装，不依赖宿主机 python）────────────────────────",
    `PYTHON_HOME=${pythonHome}`,
    `# python3/pip3 路径由 env-builder.ts 自动 prepend 到 PATH`,
    "",
    "# ─── Node.js（bundle 级独立安装，不依赖宿主机 node）────────────────────────",
    `NODE_HOME=${nodeHome}`,
    `NODE_PATH=${nmPath}`,
    `# npm install 默认装到此目录（等效于 npm install --prefix ${bundleLibPath}）`,
    `NPM_CONFIG_PREFIX=${bundleLibPath}`,
    "",
    "# ─── Playwright（浏览器二进制，按需安装）────────────────────────────────────",
    `PLAYWRIGHT_BROWSERS_PATH=${browsersPath}`,
    `# 安装浏览器命令示例（在 brain shell 中执行）：`,
    `#   npx playwright install chromium`,
    "",
    "# ─── /usr/local overlay（namespace 内持久写入）───────────────────────────────",
    `LD_LIBRARY_PATH=/usr/local/lib:/usr/local/lib64`,
    `PKG_CONFIG_PATH=/usr/local/lib/pkgconfig:/usr/local/share/pkgconfig`,
    "",
  ];

  await writeFile(envPath, lines.join("\n"), "utf-8");
}

// ─── 下载 + 解压 helpers ──────────────────────────────────────────────────────

/**
 * 将 URL 下载到 destPath，带进度回调（0-100）。
 * 使用 Node.js 原生 fetch（Node 18+）。
 */
async function downloadFile(
  url: string,
  destPath: string,
  onProgress?: (pct: number) => void,
): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${url}`);

  const total = Number(res.headers.get("content-length") ?? 0);
  let received = 0;
  let lastPct = -1;

  const writer = createWriteStream(destPath);
  const reader = res.body!.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      writer.write(value);
      if (total > 0 && onProgress) {
        received += value.length;
        const pct = Math.floor(received / total * 100);
        if (pct !== lastPct) { lastPct = pct; onProgress(pct); }
      }
    }
    await new Promise<void>((res, rej) => {
      writer.end();
      writer.on("finish", res);
      writer.on("error", rej);
    });
  } catch (e) {
    writer.destroy();
    throw e;
  }
}

/**
 * 将 .tar.gz 文件解压到 destDir（使用系统 tar 命令，最可靠）。
 */
async function extractTarGz(tarPath: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  await execAsync(`tar -xzf '${tarPath}' -C '${destDir}'`);
}

async function listDir(dir: string): Promise<string> {
  try {
    const { stdout } = await execAsync(`ls '${dir}' 2>/dev/null || echo "(empty)"`);
    return stdout.trim();
  } catch {
    return "(error listing)";
  }
}
