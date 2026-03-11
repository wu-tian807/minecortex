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
 *   - 内建三类能力（tools/slots/subscriptions）的 .ts 发现与 loadAll 流程
 *   - FSWatcher 注册：从 capabilitySources 自动推导 watch 目录，覆盖三层
 *     无需手写 regex——sources 本身就是 global / bundle / local 层的物化
 *   - 热更新：文件变更时调用 onWatchedFileChanged → reloadAll
 *
 * 子类通常只需要 `load()` 返回值定制 + 可选 registerWatchers() override（追加额外 watch）。
 */

import { relative } from "node:path";
import { isAbsolute } from "node:path";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  CapabilityDescriptor,
  CapabilitySelector,
  CapabilitySource,
  FSWatcherAPI,
  FSChangeEvent,
  PathManagerAPI,
} from "../core/types.js";
import { runWithLogContext } from "../core/logger.js";
import type { LoaderContext } from "./types.js";

function resolveBuiltInDir(
  pm: PathManagerAPI,
  brainId: string,
  kind: "tools" | "slots" | "subscriptions",
  redirected?: string,
): string[] {
  const localDir = redirected
    ? (isAbsolute(redirected) ? redirected : redirected)
    : kind === "tools"
      ? pm.local(brainId).toolsDir()
      : kind === "slots"
        ? pm.local(brainId).slotsDir()
        : pm.local(brainId).subscriptionsDir();

  const globalDir = kind === "tools"
    ? pm.global().toolsDir()
    : kind === "slots"
      ? pm.global().slotsDir()
      : pm.global().subscriptionsDir();
  const bundleDir = kind === "tools"
    ? pm.bundle().toolsDir()
    : kind === "slots"
      ? pm.bundle().slotsDir()
      : pm.bundle().subscriptionsDir();
  return [globalDir, bundleDir, localDir];
}

async function discoverTypeScriptCapabilities(
  sources: CapabilitySource[],
): Promise<CapabilityDescriptor[]> {
  const preferred = new Map<string, CapabilityDescriptor>();
  for (const source of sources) {
    try {
      const entries = await readdir(source.dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".ts")) {
          const name = entry.name.slice(0, -3);
          preferred.set(`:${name}`, {
            name,
            exposedName: name,
            path: join(source.dir, entry.name),
            sourceId: source.id,
          });
          continue;
        }
        if (!entry.isDirectory()) continue;
        const tag = entry.name;
        try {
          const taggedEntries = await readdir(join(source.dir, tag), { withFileTypes: true });
          for (const taggedEntry of taggedEntries) {
            if (!taggedEntry.isFile() || !taggedEntry.name.endsWith(".ts")) continue;
            const name = taggedEntry.name.slice(0, -3);
            preferred.set(`${tag}:${name}`, {
              name,
              tag,
              exposedName: name,
              path: join(source.dir, tag, taggedEntry.name),
              sourceId: source.id,
            });
          }
        } catch { /* tag dir doesn't exist */ }
      }
    } catch { /* source dir doesn't exist */ }
  }

  const descriptors = [...preferred.values()];
  const nameCount = new Map<string, number>();
  for (const d of descriptors) nameCount.set(d.name, (nameCount.get(d.name) ?? 0) + 1);
  for (const d of descriptors) {
    d.exposedName = (nameCount.get(d.name) ?? 1) > 1 ? `${d.name}@${d.tag ?? "default"}` : d.name;
  }
  return descriptors;
}

function resolveToken(token: string, descriptors: CapabilityDescriptor[]): CapabilityDescriptor[] {
  if (token.startsWith("#")) {
    const tag = token.slice(1);
    return descriptors.filter((d) => d.tag === tag);
  }

  const atIndex = token.lastIndexOf("@");
  if (atIndex > 0) {
    const name = token.slice(0, atIndex);
    const tag = token.slice(atIndex + 1);
    return descriptors.filter((d) => d.name === name && d.tag === tag);
  }

  const matches = descriptors.filter((d) => d.name === token);
  if (matches.length === 1) return matches;
  if (matches.length > 1) {
    console.warn(`[BaseLoader] ambiguous bare capability "${token}", use "name@tag" instead`);
  }
  return [];
}

export abstract class BaseLoader<TFactory, TInstance> {
  // ─── 静态 source 构建工具 ───

  static buildSources(
    pm: PathManagerAPI,
    brainId: string,
    kind: "tools" | "slots" | "subscriptions",
    redirected?: string,
  ): CapabilitySource[] {
    const [globalDir, bundleDir, localDir] = resolveBuiltInDir(pm, brainId, kind, redirected);
    return [
      { id: "global", dir: globalDir },
      { id: "bundle", dir: bundleDir },
      { id: brainId, dir: localDir },
    ];
  }

  // ─── 状态 ───

  protected registry = new Map<string, TInstance>();
  protected logBrainId = "scheduler";
  protected lastCtx?: LoaderContext;
  private storedWatcher?: FSWatcherAPI;
  private watchersRegistered = false;
  /** Monotonically incremented on each _loadInternal call to detect stale concurrent loads. */
  private _loadGeneration = 0;

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

  /**
   * watch 时用于匹配 source 目录内文件路径的 regex 片段。
   * 内建 loader 固定使用 .ts 文件与 tag 子目录。
   */
  protected fileWatchPattern(): string {
    return "(?:[^/]+/)?[^/]+\\.ts";
  }

  // ─── 模板：加载 ───

  /**
   * 内部加载流程：discoverTypeScriptCapabilities → clearRegistry → loadAll。
   * 首次加载后自动将 FSWatcher 绑定到所有 capabilitySources（三层覆盖）。
   *
   * Generation guard: each _loadInternal call increments _loadGeneration.
   * If a newer call starts while this one is awaiting importFactory, the stale
   * load is aborted before it can register any instances — preventing hook leaks
   * that would otherwise cause duplicate event handlers (e.g. 4× streaming output).
   */
  protected async _loadInternal(ctx: LoaderContext): Promise<void> {
    const firstLoad = !this.lastCtx;
    this.lastCtx = ctx;
    const gen = ++this._loadGeneration;
    const descriptors = await discoverTypeScriptCapabilities(ctx.capabilitySources);
    if (gen !== this._loadGeneration) return; // superseded by a newer load
    this.clearRegistry();
    await this.loadAll(descriptors, ctx, gen);

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

  /**
   * Load all capabilities that pass the CapabilitySelector in ctx.selector.
   *
   * Selector filtering is centralised here — every subclass (ToolLoader, SlotLoader,
   * SubscriptionLoader, and any future loader) gets it automatically by calling
   * _loadInternal() → loadAll(). No loader needs to re-implement this logic.
   *
   * The selector itself is read from brain.json by the Scheduler and passed in via
   * LoaderContext. configure_tools / configure_slots / configure_subscriptions write
   * changes back to brain.json; the FSWatcher picks them up and calls reloadAll(),
   * which feeds the new selector into the next loadAll() call.
   */
  async loadAll(
    descriptors: CapabilityDescriptor[],
    ctx: LoaderContext,
    gen?: number,
  ): Promise<Map<string, TInstance>> {
    for (const descriptor of BaseLoader.filterByCapability(descriptors, ctx.selector)) {
      try {
        await runWithLogContext({ brainId: this.logBrainId, turn: 0 }, async () => {
          const factory = await this.importFactory(`${descriptor.path}?t=${Date.now()}`);
          // If a newer _loadInternal has started, discard this result to prevent
          // stale start() calls from leaking hook registrations.
          if (gen !== undefined && gen !== this._loadGeneration) return;
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

  static filterByCapability(
    descriptors: CapabilityDescriptor[],
    selector: CapabilitySelector,
  ): CapabilityDescriptor[] {
    const selected = new Map<string, CapabilityDescriptor>();

    for (const d of descriptors) {
      if (d.sourceId !== "global" && d.sourceId !== "bundle") {
        selected.set(d.exposedName, d);
      } else if (d.sourceId === "bundle") {
        if ((selector.bundle ?? "none") === "all") selected.set(d.exposedName, d);
      } else {
        if ((selector.global ?? "none") === "all") selected.set(d.exposedName, d);
      }
    }

    for (const token of selector.enable ?? []) {
      for (const d of resolveToken(token, descriptors)) selected.set(d.exposedName, d);
    }

    for (const token of selector.disable ?? []) {
      for (const d of resolveToken(token, descriptors)) selected.delete(d.exposedName);
    }

    return [...selected.values()];
  }
}
