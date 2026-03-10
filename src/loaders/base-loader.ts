/**
 * BaseLoader<TFactory, TInstance> — 能力加载的通用骨架。
 *
 * 模板方法模式：子类只需实现：
 *   1. importFactory(path)      — 如何加载一个文件（dynamic import 或 fs read）
 *   2. validateFactory(factory) — 判断加载结果是否合法
 *   3. createInstance(...)      — 从 factory 构建实例
 *   4. onRegister / onUnregister — 实例注册/注销的副作用
 *
 * BaseLoader 自动处理：
 *   - discover(scanFn) + loadAll 的完整加载流程（_loadInternal）
 *   - FSWatcher 注册：从 capabilitySources 自动推导 watch 目录，覆盖三层
 *     无需手写 regex——sources 本身就是 global / bundle / local 层的物化
 *   - 热更新：文件变更时调用 onWatchedFileChanged → reloadAll
 *
 * 子类通常只需要 `load()` 返回值定制 + 可选 registerWatchers() override（追加额外 watch）。
 */

import { relative } from "node:path";
import { isAbsolute } from "node:path";
import type {
  CapabilityDescriptor,
  CapabilitySelector,
  CapabilitySource,
  FSWatcherAPI,
  FSChangeEvent,
  PathManagerAPI,
} from "../core/types.js";
import { runWithLogContext } from "../core/logger.js";
import { discover, filterByCapability, flatFilesAndTags } from "./scanner.js";
import type { ScanFn } from "./scanner.js";
import type { LoaderContext } from "./types.js";

export abstract class BaseLoader<TFactory, TInstance> {
  // ─── 静态 source 构建工具 ───

  static buildSources(
    pm: PathManagerAPI,
    brainId: string,
    kind: "tools" | "slots" | "subscriptions",
    redirected?: string,
  ): CapabilitySource[] {
    const g = pm.global();
    const globalDir = kind === "tools" ? g.toolsDir()
      : kind === "slots" ? g.slotsDir()
      : g.subscriptionsDir();

    const l = pm.local(brainId);
    const defaultLocal = kind === "tools" ? l.toolsDir()
      : kind === "slots" ? l.slotsDir()
      : l.subscriptionsDir();

    const localDir = redirected
      ? (isAbsolute(redirected) ? redirected : redirected)
      : defaultLocal;

    return [
      { id: "global", dir: globalDir },
      { id: brainId, dir: localDir },
    ];
  }

  static buildExtraSources(
    pm: PathManagerAPI,
    brainId: string,
    name: string,
  ): CapabilitySource[] {
    return [
      { id: "global", dir: pm.global().extraDir(name) },
      { id: brainId, dir: pm.local(brainId).extraDir(name) },
    ];
  }

  // ─── 状态 ───

  protected registry = new Map<string, TInstance>();
  protected logBrainId = "scheduler";
  protected lastCtx?: LoaderContext;
  private storedWatcher?: FSWatcherAPI;
  private watchersRegistered = false;

  // ─── 抽象接口（子类必须实现）───

  abstract importFactory(path: string): Promise<TFactory>;
  abstract validateFactory(factory: TFactory): boolean;
  abstract createInstance(
    factory: TFactory,
    ctx: LoaderContext,
    name: string,
    descriptor: CapabilityDescriptor,
  ): TInstance;
  abstract onRegister(name: string, instance: TInstance): void;
  abstract onUnregister(name: string, instance: TInstance): void;

  // ─── 扫描策略 ───

  /**
   * 返回此 loader 使用的扫描策略（默认：.ts 文件 + tag 子目录）。
   * 内容 loader 覆盖为 flatFiles(".md")；目录型 loader 覆盖为 scanDirs()。
   */
  protected scanFn(): ScanFn { return flatFilesAndTags(); }

  /**
   * watch 时用于匹配 source 目录内文件路径的 regex 片段。
   * 与 scanFn() 对应：默认 .ts + tag 子目录；内容 loader 覆盖为 "[^/]+\\.md"。
   * BaseLoader 在 registerWatchers() 里将其拼合到 source 相对路径上。
   */
  protected fileWatchPattern(): string {
    return "(?:[^/]+/)?[^/]+\\.ts";
  }

  // ─── 模板：加载 ───

  /**
   * 内部加载流程：discover(scanFn) → clearRegistry → loadAll。
   * 首次加载后自动将 FSWatcher 绑定到所有 capabilitySources（三层覆盖）。
   */
  protected async _loadInternal(ctx: LoaderContext): Promise<void> {
    const firstLoad = !this.lastCtx;
    this.lastCtx = ctx;
    const descriptors = await discover(ctx.capabilitySources, this.scanFn());
    this.clearRegistry();
    await this.loadAll(descriptors, ctx);

    if (firstLoad && this.storedWatcher && !this.watchersRegistered) {
      this.registerWatchers(this.storedWatcher, ctx);
      this.watchersRegistered = true;
    }
  }

  // ─── 模板：FSWatcher ───

  /**
   * 存储 watcher 引用（真正的注册在首次 _loadInternal 完成后进行）。
   * 子类通常不需要 override 此方法。
   */
  registerWatchPatterns(watcher: FSWatcherAPI): void {
    this.storedWatcher = watcher;
  }

  /**
   * 将 capabilitySources 中的每个目录自动转换成 FSWatcher pattern 并注册。
   * source 已经包含 global / bundle / local 三层，pattern 按层精确对应：
   *   - global source → ^tools/…\.ts$
   *   - local source  → ^bundle/brains/{id}/tools/…\.ts$
   *
   * 子类可 override 以追加额外 watch（如 SlotLoader 追加 .md 内容文件）。
   */
  protected registerWatchers(watcher: FSWatcherAPI, ctx: LoaderContext): void {
    const root = ctx.pathManager.root();
    const fp = this.fileWatchPattern();
    for (const source of ctx.capabilitySources) {
      const rel = relative(root, source.dir).replace(/\\/g, "/");
      if (!rel || rel.startsWith("..")) continue;
      const escaped = rel.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
      watcher.register(
        new RegExp(`^${escaped}/${fp}$`),
        (event) => this.onWatchedFileChanged(event),
      );
    }
  }

  /**
   * 文件变更默认处理：直接 reloadAll。
   * 子类可 override 以实现更细粒度的处理（如单文件 reload）。
   */
  protected onWatchedFileChanged(event: FSChangeEvent): void {
    if (!this.lastCtx) return;
    this.reloadAll()
      .then(() => console.log(`[${this.constructor.name}] refreshed: ${event.path}`))
      .catch(err => console.error(`[${this.constructor.name}] refresh failed: ${event.path}`, err));
  }

  /** 重新从上次 ctx 加载所有能力。 */
  protected async reloadAll(): Promise<void> {
    if (!this.lastCtx) return;
    await this._loadInternal(this.lastCtx);
  }

  // ─── 底层工具 ───

  setLogContext(brainId = "scheduler"): void {
    this.logBrainId = brainId;
  }

  async loadAll(
    descriptors: CapabilityDescriptor[],
    ctx: LoaderContext,
  ): Promise<Map<string, TInstance>> {
    for (const descriptor of filterByCapability(descriptors, ctx.selector)) {
      try {
        await runWithLogContext({ brainId: this.logBrainId, turn: 0 }, async () => {
          const factory = await this.importFactory(`${descriptor.path}?t=${Date.now()}`);
          if (!this.validateFactory(factory)) return;
          const instance = this.createInstance(factory, ctx, descriptor.exposedName, descriptor);
          this.registry.set(descriptor.exposedName, instance);
          this.onRegister(descriptor.exposedName, instance);
        });
      } catch (err) {
        console.error(`[BaseLoader] failed to load "${descriptor.exposedName}"`, err);
      }
    }
    return this.registry;
  }

  async reload(
    name: string,
    path: string,
    ctx: LoaderContext,
    descriptor?: CapabilityDescriptor,
  ): Promise<TInstance | undefined> {
    const old = this.registry.get(name);
    if (old) {
      this.onUnregister(name, old);
      this.registry.delete(name);
    }
    try {
      return await runWithLogContext({ brainId: this.logBrainId, turn: 0 }, async () => {
        const factory = await this.importFactory(`${path}?t=${Date.now()}`);
        if (!this.validateFactory(factory)) return undefined;
        const instance = this.createInstance(
          factory, ctx, name,
          descriptor ?? { name, exposedName: name, path },
        );
        this.registry.set(name, instance);
        this.onRegister(name, instance);
        return instance;
      });
    } catch (err) {
      console.error(`[BaseLoader] failed to reload "${name}"`, err);
      return undefined;
    }
  }

  get(name: string): TInstance | undefined {
    return this.registry.get(name);
  }

  getAll(): Map<string, TInstance> {
    return this.registry;
  }

  protected clearRegistry(): void {
    for (const [name, instance] of this.registry) this.onUnregister(name, instance);
    this.registry.clear();
  }

  protected resolveConfig(
    selector: CapabilitySelector,
    descriptor: CapabilityDescriptor,
  ): Record<string, unknown> | undefined {
    return selector.config?.[descriptor.exposedName] ?? selector.config?.[descriptor.name];
  }
}
