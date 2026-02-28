---
name: "P3: FSWatcher + BaseLoader 基础设施"
order: 3
overview: "纯注册式可扩展文件监听器 + 三 Loader 通用基类 + invalidate 协议 + ESM 热重载。FSWatcher 不写死任何路径分发规则，所有 handler 由消费方（Loader/SlotFactory/Scheduler）自行注册。"
depends_on: ["P0"]
unlocks: ["P7", "P8"]
parallel_group: "phase-1"
todos:
  - id: fswatcher
    content: "新建 src/core/fs-watcher.ts — 纯注册式 FSWatcher: register(pattern,handler,opts)/unregister(id) + 防抖 + 零硬编码路径"
  - id: base-loader
    content: "新建 src/loaders/base-loader.ts — BaseLoader<TFactory, TInstance> 抽象基类: discover/filterByCapability/loadAll/reload + registerWatchPatterns(watcher)抽象方法"
  - id: tool-loader-refactor
    content: "重写 src/loaders/tool-loader.ts — 继承 BaseLoader + registerWatchPatterns注册自身监听 + ESM cache-bust"
  - id: subscription-loader-refactor
    content: "重写 src/loaders/subscription-loader.ts — 继承 BaseLoader + reconcile(oldConfig, newConfig) + registerWatchPatterns + 错误保护"
  - id: scheduler-watcher
    content: "修改 src/core/scheduler.ts — 创建 FSWatcher 实例 + 各 Loader 自行调用 registerWatchPatterns(watcher) + Scheduler 只注册 brains/ 目录级变更(新建/删除脑)"
  - id: esm-cache-bust
    content: "实现 ESM 热重载: import(`${path}?t=${Date.now()}`) cache-busting 方案"
---

# P3: FSWatcher + BaseLoader 基础设施

## 目标

实现**纯注册式可扩展**的文件系统监听 + 三 Loader（subscription/tool/slot）的通用基类。
这是 **P7（Slot 系统）和 P8（订阅管理）的前置依赖**。

## 核心设计原则

**FSWatcher 不写死任何路径分发规则**。它是一个纯粹的事件分发器：

- FSWatcher 只提供 `register(pattern, handler, opts)` 和 `unregister(id)` API
- 每个消费方（Loader、SlotFactory、Scheduler）自行注册自己关心的路径模式
- 新增资源类型（如 skills、directives）时，只需在对应的 Loader/SlotFactory 中注册新的 watch pattern，FSWatcher 代码零修改
- 这确保了 skills、directives 等作为 slots 的扩展衍生，天然获得 fs-watcher 能力

## 可并行

与 P1、P2、P4、P5、P6 完全并行。

## FSWatcher 设计

### 纯注册式 API

```typescript
interface WatchRegistration {
  id: string;           // 注册者自动生成的唯一 ID
  dispose(): void;      // 取消注册
}

interface FSChangeEvent {
  type: "create" | "modify" | "delete";
  path: string;         // 相对项目根的路径
  isDir: boolean;
}

type FSHandler = (event: FSChangeEvent) => void | Promise<void>;

interface WatchOptions {
  debounceMs?: number;  // 默认 300ms
}

class FSWatcher {
  private registrations: Map<string, {
    pattern: RegExp;
    handler: FSHandler;
    debounceMs: number;
  }>;
  private watcher: fs.FSWatcher;
  private debounceTimers: Map<string, NodeJS.Timeout>;

  constructor(rootDir: string) {
    this.watcher = fs.watch(rootDir, { recursive: true });
    this.watcher.on("change", (eventType, filename) => this.dispatch(filename));
  }

  // 注册: 返回 WatchRegistration 以便取消
  register(pattern: RegExp, handler: FSHandler, opts?: WatchOptions): WatchRegistration;

  // 关闭整个 watcher
  close(): void;

  // 内部分发: 遍历所有 registration，pattern 匹配则触发(带防抖)
  private dispatch(filename: string): void {
    for (const [id, reg] of this.registrations) {
      if (reg.pattern.test(filename)) {
        this.debounce(`${id}:${filename}`, () => reg.handler({
          type: this.inferType(filename),
          path: filename,
          isDir: this.isDirectory(filename),
        }), reg.debounceMs);
      }
    }
  }
}
```

### 关键设计：零硬编码

FSWatcher 内部 **没有任何路径表/分发表**。所有的"哪个路径触发什么行为"
完全由消费方在自己的初始化逻辑中注册：

```typescript
// tool-loader 自己注册自己的 watch 模式
class ToolLoader extends BaseLoader<ToolFactory, ToolDefinition> {
  registerWatchPatterns(watcher: FSWatcher): void {
    watcher.register(/^tools\/.*\.ts$/, (e) => this.onGlobalToolChange(e));
    watcher.register(/^brains\/[^/]+\/tools\/.*\.ts$/, (e) => this.onBrainToolChange(e));
  }
}

// subscription-loader 自己注册自己的
class SubscriptionLoader extends BaseLoader<EventSourceFactory, EventSource> {
  registerWatchPatterns(watcher: FSWatcher): void {
    watcher.register(/^subscriptions\/.*\.ts$/, (e) => this.onGlobalSourceChange(e));
    watcher.register(/^brains\/[^/]+\/subscriptions\/.*\.ts$/, (e) => this.onBrainSourceChange(e));
    watcher.register(/^brains\/[^/]+\/brain\.json$/, (e) => this.onBrainConfigChange(e), { debounceMs: 1000 });
  }
}

// slot-loader 注册 slots + 间接依赖(directives/*.md, skills/, soul.md)
class SlotLoader extends BaseLoader<SlotFactory, ContextSlot> {
  registerWatchPatterns(watcher: FSWatcher): void {
    watcher.register(/^slots\/.*\.ts$/, (e) => this.onGlobalSlotChange(e));
    watcher.register(/^brains\/[^/]+\/slots\/.*\.ts$/, (e) => this.onBrainSlotChange(e));
    // 间接依赖: directives/*.md 变更 → 通知 slots/directives.ts factory 重新扫描
    watcher.register(/^directives\/.*\.md$/, (e) => this.invalidateSlot("directives"));
    watcher.register(/^brains\/[^/]+\/directives\/.*\.md$/, (e) => this.invalidateBrainSlot(e, "directives"));
    // 间接依赖: skills/ 变更
    watcher.register(/^skills\//, (e) => this.invalidateSlot("skills"));
    watcher.register(/^brains\/[^/]+\/skills\//, (e) => this.invalidateBrainSlot(e, "skills"));
    // 间接依赖: soul.md 变更
    watcher.register(/^brains\/[^/]+\/soul\.md$/, (e) => this.invalidateBrainSlot(e, "soul"));
  }
}

// Scheduler 只注册自己关心的: 脑目录级别的新建/删除
class Scheduler {
  initWatcher(watcher: FSWatcher): void {
    watcher.register(/^brains\/[^/]+\/$/, (e) => {
      if (e.type === "create" && e.isDir) this.onBrainDiscovered(e.path);
      if (e.type === "delete" && e.isDir) this.onBrainRemoved(e.path);
    });
  }
}
```

### 可扩展性示例

当未来新增资源类型（如 `prompts/`、`memories/`）时：

```typescript
// 新的 PromptLoader 只需在自己的 registerWatchPatterns 中注册
class PromptLoader {
  registerWatchPatterns(watcher: FSWatcher): void {
    watcher.register(/^prompts\/.*\.md$/, (e) => this.onPromptChange(e));
    watcher.register(/^brains\/[^/]+\/prompts\/.*\.md$/, (e) => this.onBrainPromptChange(e));
  }
}
// FSWatcher 代码: 零修改
```

### 初始化流程

```typescript
// scheduler.ts 启动时
const watcher = new FSWatcher(PROJECT_ROOT);

// 各 Loader 自行注册（顺序无关）
toolLoader.registerWatchPatterns(watcher);
subscriptionLoader.registerWatchPatterns(watcher);
slotLoader.registerWatchPatterns(watcher);  // P7 阶段加入
this.initWatcher(watcher);                  // Scheduler 自身的注册
```

## BaseLoader 通用基类

```typescript
abstract class BaseLoader<TFactory, TInstance> {
  protected registry: Map<string, TInstance> = new Map();

  protected abstract importFactory(path: string): Promise<TFactory>;
  protected abstract createInstance(factory: TFactory, ctx: unknown): TInstance;
  protected abstract onRegister(name: string, instance: TInstance): void;
  protected abstract onUnregister(name: string, instance: TInstance): void;

  // 每个 Loader 子类实现: 注册自己关心的 watch 模式
  abstract registerWatchPatterns(watcher: FSWatcher): void;

  // 发现: 全局目录 + 脑专属目录 → Map<name, absolutePath>（内覆盖外）
  discover(globalDir: string, localDir: string): Map<string, string>;

  // 过滤: 按 CapabilitySelector 决定启用哪些
  filterByCapability(names: Map<string, string>, selector: CapabilitySelector): string[];

  // 加载所有
  async loadAll(paths: string[], ctx: unknown): Promise<void>;

  // 热重载单个: stop旧 → cache-bust reimport → create新 → register
  async reload(name: string, path: string, ctx: unknown): Promise<void>;
}
```

### ESM Cache-Bust 热重载

```typescript
async importFactory(path: string): Promise<TFactory> {
  const mod = await import(`${path}?t=${Date.now()}`);
  return mod.default ?? mod.create;
}
```

### subscription-loader.reconcile()

```typescript
async reconcile(oldConfig: CapabilitySelector, newConfig: CapabilitySelector): Promise<void> {
  const oldEnabled = this.resolveEnabled(oldConfig);
  const newEnabled = this.resolveEnabled(newConfig);

  for (const name of newEnabled) {
    if (!oldEnabled.has(name)) await this.startSource(name);
  }

  for (const name of oldEnabled) {
    if (!newEnabled.has(name)) await this.stopSource(name);
  }
}
```

### 错误保护

- `source.start()` 包 try-catch，失败时 emit `{ source: "system", type: "subscription_error" }` 到对应脑
- emit 回调用 wrapper 防止运行时异常扩散
- 热重载失败时保留旧版本运行，不中断服务

## 涉及文件

| 操作 | 文件 |
|------|------|
| 新建 | `src/core/fs-watcher.ts` |
| 新建 | `src/loaders/base-loader.ts` |
| 重写 | `src/loaders/tool-loader.ts` |
| 重写 | `src/loaders/subscription-loader.ts` |
| 修改 | `src/core/scheduler.ts` |

## 参考实现

- `references/openclaw/src/gateway/config-reload.ts` — debounce + diff + reloadPlan
- `references/agent_fcos/pkg/builtin_nodes/agentic/` — WorkTracker 脏数据追踪
