/**
 * AbstractContentLoader<TInstance> — 内容文件（.md）BaseLoader 子类骨架。
 *
 * 相比代码文件 loader（.ts），内容 loader 的差异：
 *  - ext() 返回 ".md"
 *  - watchPatterns() 由 kindName() 自动生成（global + local 两层）
 *  - importFactory 剥离 ?t=... 缓存破坏参数，返回文件元数据（非 dynamic import）
 *  - 提供 scanSync(pm, brainId) 供 SlotFactory（同步签名）直接调用
 *
 * 子类（如 DirectivesLoader / SkillsLoader）放在能力包层（slots/lib/），
 * 而非 src/，体现「框架层 vs 能力层」的分离。
 *
 * 激活路径（当前）：
 *   Scheduler → SlotLoader → slot factory → loader.scanSync()
 * 激活路径（未来独立 loader）：
 *   Scheduler → loader.load({ capabilitySources: BaseLoader.buildExtraSources(...) })
 */

import { basename, join } from "node:path";
import { readdirSync } from "node:fs";
import type { CapabilityDescriptor, FSWatcherAPI, PathManagerAPI } from "../core/types.js";
import type { LoaderContext } from "./types.js";
import { BaseLoader } from "./base-loader.js";
import { flatFiles } from "./scanner.js";
import type { ScanFn } from "./scanner.js";

export interface ContentItem {
  name: string;
  path: string;
}

export abstract class AbstractContentLoader<TInstance> extends BaseLoader<ContentItem, TInstance> {
  /** 内容目录名，如 "directives" 或 "skills"。 */
  protected abstract kindName(): string;

  /**
   * 从单个文件路径构建实例。
   * 返回 null 表示跳过该文件（如 frontmatter 缺少必要字段）。
   */
  protected abstract buildFromFile(name: string, path: string): TInstance | null;

  // ─── BaseLoader 虚方法覆盖 ───

  /**
   * 内容文件默认用 flatFiles(".md")（平铺扫描，不进子目录）。
   * 子类可覆盖为 scanDirs() 以支持目录型能力单元（如未来的 skill-as-directory）。
   */
  protected override scanFn(): ScanFn { return flatFiles(); }

  /**
   * 覆盖文件匹配片段为 .md 平铺格式。
   * BaseLoader.registerWatchers() 会将 source 相对路径 + 此片段自动拼合成 watch regex，
   * 无需手写完整 RegExp。
   */
  protected override fileWatchPattern(): string { return "[^/]+\\.md"; }

  // ─── BaseLoader 抽象接口实现 ───

  /**
   * 剥离 BaseLoader.loadAll 添加的 ?t=... 缓存破坏参数后返回元数据。
   * 不做 dynamic import，实际内容由 buildFromFile / content() 懒读。
   */
  async importFactory(pathWithQuery: string): Promise<ContentItem> {
    const path = pathWithQuery.replace(/\?[^?]*$/, "");
    return { name: basename(path, ".md"), path };
  }

  validateFactory(_item: ContentItem): boolean { return true; }

  createInstance(
    factory: ContentItem,
    _ctx: LoaderContext,
    name: string,
    _descriptor: CapabilityDescriptor,
  ): TInstance {
    const result = this.buildFromFile(name, factory.path);
    if (result === null) throw new Error(`[ContentLoader] buildFromFile returned null for "${name}"`);
    return result;
  }

  /** 激活由 slot 系统负责，默认为空实现（独立 loader 模式下可 override）。 */
  onRegister(_name: string, _instance: TInstance): void {}
  onUnregister(_name: string, _instance: TInstance): void {}

  // ─── 同步扫描（slot factory 激活路径）───

  /**
   * 同步扫描 global + local 两层，返回实例列表（local 覆盖 global 同名文件）。
   * 供 SlotFactory（同步签名）直接调用。
   */
  scanSync(pm: PathManagerAPI, brainId: string): TInstance[] {
    const dirs = [
      pm.global().extraDir(this.kindName()),
      pm.local(brainId).extraDir(this.kindName()),
    ];
    const map = new Map<string, TInstance>();
    for (const dir of dirs) {
      try {
        for (const file of readdirSync(dir)) {
          if (!file.endsWith(".md")) continue;
          const name = file.slice(0, -3);
          const instance = this.buildFromFile(name, join(dir, file));
          if (instance !== null) map.set(name, instance);
        }
      } catch { /* 目录不存在 — 跳过 */ }
    }
    return [...map.values()];
  }

  // ─── 静态工具（供 SlotLoader 等框架层调用）───

  /**
   * 为指定 kind 注册 global + local 两层的 .md 文件 watch 模式。
   * SlotLoader 通过此方法委托 directives/skills 的 watch 注册，
   * 无需反向依赖 slots/lib/ 中的具体 loader 类。
   */
  static registerContentPatterns(
    watcher: FSWatcherAPI,
    kind: string,
    onChanged: (path: string) => void,
  ): void {
    watcher.register(
      new RegExp(`^${kind}/[^/]+\\.md$`),
      (e) => onChanged(e.path),
    );
    watcher.register(
      new RegExp(`^bundle/brains/[^/]+/${kind}/[^/]+\\.md$`),
      (e) => onChanged(e.path),
    );
  }
}
