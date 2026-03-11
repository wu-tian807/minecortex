import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { getPathManager } from "../fs/index.js";
import { initTerminalManager, getTerminalManager } from "../terminal/manager.js";
import { getScheduler } from "../core/scheduler.js";
import { createOrGetFSWatcher, getFSWatcher } from "../fs/watcher.js";
import { ensureBundleEnvironment } from "./env-init.js";

interface BundleManifest {
  bundleId: string;
  source: {
    type: "pack" | "backup";
    id: string;
    version: string;
  };
  runtimeState: {
    pythonInstalled?: boolean;
    nodeInstalled?: boolean;
    envInitialized?: boolean;
    setupScriptRan?: boolean;
  };
  createdAt: string;
  lastStartedAt: string;
}

export class BundleManager {
  private static instance: BundleManager;

  public static getInstance(): BundleManager {
    if (!BundleManager.instance) {
      BundleManager.instance = new BundleManager();
    }
    return BundleManager.instance;
  }

  private ensureTerminalManagerInitialized(): void {
    const pm = getPathManager();
    try {
      getTerminalManager();
    } catch {
      initTerminalManager(pm);
    }
  }

  async init(): Promise<void> {
    const pm = getPathManager();
    const manifestPath = pm.bundle().manifest();

    // 确保 FSWatcher 已启动 (热更新依赖)
    if (!getFSWatcher()) {
      try {
        createOrGetFSWatcher(pm.root());
      } catch (err) {
        console.warn("[BundleManager] FSWatcher creation failed — hot-reload disabled", err);
      }
    }

    // 初始化 TerminalManager (若未被初始化)
    this.ensureTerminalManagerInitialized();
    const terminalManager = getTerminalManager();

    if (!existsSync(manifestPath)) {
      // 没有任何 bundle 存在
      // 为满足 plan 要求：“若空则触发 Picker”，我们在 CLI 层应该 catch 这个异常或者主动判断。
      throw new Error("No bundle manifest found. System cannot start. Please select a pack or backup first.");
    }

    // 这里读取 manifest
    let manifest: BundleManifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
    } catch {
      throw new Error("Invalid manifest.json format");
    }

    await terminalManager.ensureReady(); // 确保 namespace 探测可用

    // 加载 system 环境变量
    await terminalManager.loadSystemEnv();

    // 确保 Node.js 和 Python 在 /usr/local 内安装，并传递 manifest 进行断点控制
    const saveManifest = async () => writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
    await ensureBundleEnvironment(pm.bundle().root(), manifest, saveManifest);

    // 独立进行 Env 初始化控制
    if (!manifest.runtimeState.envInitialized) {
      await this.initBaseEnv();
      await this.initBrainsDotEnv();
      manifest.runtimeState.envInitialized = true;
      await saveManifest();
    }

    // base.env 可能刚刚生成（envInitialized 从 false 变 true），也可能是 bundle 重启时
    // 首次 loadSystemEnv 时 base.env 已存在 — 无论如何此处重新加载一次，确保
    // PYTHON_HOME / NODE_HOME 等变量在 runSystemSetup 执行前已注入 env 缓存。
    await terminalManager.loadSystemEnv();

    // 检测 setupScriptRan 状态
    if (!manifest.runtimeState.setupScriptRan) {
      // 说明还没跑完 setup.sh，需要用 System Terminal 去跑
      await this.runSystemSetup(manifest);
      await saveManifest();
    }

    // 记录最后启动时间
    manifest.lastStartedAt = new Date().toISOString();
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  }

  private async initBaseEnv(): Promise<void> {
    const pm = getPathManager();
    const bundleRoot = pm.bundle().root();
    const envDir = join(bundleRoot, "shared", "env");
    const baseEnvPath = join(envDir, "base.env");

    if (!existsSync(baseEnvPath)) {
      await mkdir(envDir, { recursive: true });
      const pythonHome = join(bundleRoot, "shared", "runtime", "python");
      const nodeHome   = join(bundleRoot, "shared", "runtime", "node");
      const defaultEnv = [
        "# bundle/shared/env/base.env",
        "# 框架自动生成的全局环境变量，如果有自定义需求，可以在 setup.sh 中追加或在 brain 的 .env 中重写",
        `PYTHON_HOME=${pythonHome}`,
        `NODE_HOME=${nodeHome}`,
        `LD_LIBRARY_PATH=${pythonHome}/lib:${nodeHome}/lib:/usr/local/lib:/usr/local/lib64`,
        `PKG_CONFIG_PATH=${pythonHome}/lib/pkgconfig:/usr/local/lib/pkgconfig:/usr/local/share/pkgconfig`,
        ""
      ].join("\n");
      await writeFile(baseEnvPath, defaultEnv, "utf-8");
    }
  }

  private async initBrainsDotEnv(): Promise<void> {
    const pm = getPathManager();
    const brainsDir = pm.bundle().brainsDir();
    if (!existsSync(brainsDir)) return;
    
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(brainsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const envPath = join(brainsDir, entry.name, ".env");
        if (!existsSync(envPath)) {
          await writeFile(envPath, `# Private Env for Brain: ${entry.name}\n`, "utf-8");
        }
      }
    }
  }

  private async runSystemSetup(manifest: BundleManifest): Promise<void> {
    const pm = getPathManager();
    const terminalManager = getTerminalManager();
    
    // System Terminal 是通过 exec 运行 root 命令
    const setupScriptPath = join(pm.bundle().root(), "startup-scripts", "setup.sh");
    if (!existsSync(setupScriptPath)) {
      // 如果根本没有 setup.sh，直接标记成功
      manifest.runtimeState.setupScriptRan = true;
      return;
    }

    // 在 System Terminal 中执行 setup.sh
    console.log("[BundleManager] Running setup.sh in System Terminal...");
    const res = await terminalManager.exec("bash ./startup-scripts/setup.sh", {
      cwd: pm.bundle().root(),
      description: "bundle-setup",
      timeoutMs: 0, // 0 = infinite timeout (wait for completion)
    });

    if (res.exitCode === 0) {
      console.log("[BundleManager] setup.sh succeeded.");
      manifest.runtimeState.setupScriptRan = true;
      // startup-scripts 保留，manifest.json 的 setupScriptRan 标志已足够防止重复执行。
      // 如需重跑 setup，只需将 setupScriptRan 重置为 false 即可。
    } else {
      console.error(`[BundleManager] setup.sh failed with exit code ${res.exitCode}. Log: ${res.logFile}`);
      // 保留文件夹以便下次重试
    }
  }

  private async autoBackupCurrentBundle(): Promise<void> {
    const pm = getPathManager();
    const manifestPath = pm.bundle().manifest();
    if (!existsSync(manifestPath)) return;

    try {
      const manifest: BundleManifest = JSON.parse(await readFile(manifestPath, "utf-8"));
      if (manifest.bundleId) {
        console.log(`[BundleManager] Auto-backing up current bundle: ${manifest.bundleId}`);
        await this.saveCurrentBundleToBackup(manifest.bundleId);
      }
    } catch (err) {
      console.warn("[BundleManager] Failed to auto-backup current bundle:", err);
    }
  }

  async loadPackToBundle(packId: string): Promise<void> {
    const pm = getPathManager();
    const bundleRoot = pm.bundle().root();
    const packDir = pm.packDir(packId);

    if (!existsSync(packDir)) {
      throw new Error(`Pack ${packId} not found at ${packDir}`);
    }

    // 无论 bundle 是否存在，先停 scheduler + 清理 terminal（防止空/损坏 bundle 跳过备份时 scheduler 仍运行）
    this.ensureTerminalManagerInitialized();
    const scheduler = getScheduler();
    if (scheduler) await scheduler.stop();
    getTerminalManager().cleanup(0);

    // 清空现有 bundle/ 前自动备份（无 manifest 时 autoBackup 会静默跳过）
    if (existsSync(bundleRoot)) {
      await this.autoBackupCurrentBundle();
      await rm(bundleRoot, { recursive: true, force: true });
    }
    await mkdir(bundleRoot, { recursive: true });

    // 复制 Pack 到 bundle (由于我们处于只读/纯代码模式，这里省略真实的目录深度复制，用 spawn `cp -r` 替代)
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);
    
    // 我们需要复制除了 pack.json 以外的东西（其实全复制也行）
    await execAsync(`cp -a "${packDir}/." "${bundleRoot}/"`);

    // 将 pack.json 里的 runtime overlays 转换并写到 mounts.json
    const packJsonStr = await readFile(join(packDir, "pack.json"), "utf-8");
    const packJson = JSON.parse(packJsonStr);

    const overlays = packJson.runtime?.overlays || [];
    const mountsJsonPath = pm.bundle().sandboxMounts();
    await mkdir(pm.bundle().sandboxDir(), { recursive: true });
    await writeFile(mountsJsonPath, JSON.stringify({ overlays }, null, 2), "utf-8");

    // 生成初始 Manifest
    const manifest: BundleManifest = {
      bundleId: `${packId}_${Math.random().toString(36).substring(2, 6)}`,
      source: {
        type: "pack",
        id: packId,
        version: packJson.version || "1.0.0",
      },
      runtimeState: {
        pythonInstalled: false,
        nodeInstalled: false,
        envInitialized: false,
        setupScriptRan: false,
      },
      createdAt: new Date().toISOString(),
      lastStartedAt: new Date().toISOString(),
    };
    await writeFile(pm.bundle().manifest(), JSON.stringify(manifest, null, 2), "utf-8");

    // 调用 init() 完成环境准备（错误向上抛出，不吞掉）
    await this.init();

    // 如果 Scheduler 存在，重新启动它
    if (scheduler) await scheduler.start();
  }

  async saveCurrentBundleToBackup(name: string): Promise<void> {
    const scheduler = getScheduler();
    if (scheduler) {
      await scheduler.stop();
    }
    
    // Ensure TerminalManager exists before cleanup
    this.ensureTerminalManagerInitialized();
    getTerminalManager().cleanup(0);

    const pm = getPathManager();
    const bundleRoot = pm.bundle().root();
    const backupsDir = pm.global().backupsDir();
    
    // Check if there is actually a bundle to backup
    if (!existsSync(bundleRoot) || !existsSync(pm.bundle().manifest())) {
      console.warn("[BundleManager] No active bundle to backup.");
      return;
    }

    await mkdir(backupsDir, { recursive: true });

    const backupPath = join(backupsDir, `${name}.zip`);

    // We use child_process directly so we don't rely on terminal instance availability
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);

    try {
      // zip -r 产生的路径以 "./" 开头，排除模式必须带 "./" 前缀才能正确匹配
      await execAsync(`cd "${bundleRoot}" && zip -r "${backupPath}" . -x "./brains/*/.tmp/*" "./shared/sandbox/tmp/*" "./.tmp/*"`);
    } catch (err) {
      console.error(`[BundleManager] Failed to zip bundle:`, err);
    }
  }

  async restoreBackupToBundle(backupPath: string): Promise<void> {
    const pm = getPathManager();
    const bundleRoot = pm.bundle().root();

    // 无论 bundle 是否存在，先停 scheduler + 清理 terminal
    this.ensureTerminalManagerInitialized();
    const scheduler = getScheduler();
    if (scheduler) await scheduler.stop();
    getTerminalManager().cleanup(0);

    if (existsSync(bundleRoot)) {
      await this.autoBackupCurrentBundle();
      await rm(bundleRoot, { recursive: true, force: true });
    }
    await mkdir(bundleRoot, { recursive: true });

    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);

    await execAsync(`unzip "${backupPath}" -d "${bundleRoot}"`);

    // 重启后调用 init() 继续完成环境准备
    await this.init();

    // 如果 Scheduler 存在，重新启动它
    if (scheduler) await scheduler.start();
  }
}
