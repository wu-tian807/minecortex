---
name: "P8: 订阅管理"
order: 8
overview: "三个独立订阅管理工具(subscribe/unsubscribe/list_subscriptions) + subscription-loader reconcile 联动 + fs-watcher brain.json handler。"
depends_on: ["P3"]
unlocks: []
parallel_group: "phase-2"
todos:
  - id: subscribe-tool
    content: "新建 tools/subscribe.ts — enable 订阅: 安全读写 brain.json subscriptions.enable[] + 可选 config"
  - id: unsubscribe-tool
    content: "新建 tools/unsubscribe.ts — disable 订阅: 安全读写 brain.json subscriptions.disable[]"
  - id: list-subscriptions-tool
    content: "新建 tools/list_subscriptions.ts — 只读查询当前订阅状态(name/status/scope)"
  - id: reconcile-integration
    content: "确保 fs-watcher brain.json handler → subscription-loader.reconcile() 联动正确"
  - id: source-hot-reload
    content: "确保 fs-watcher subscriptions/*.ts handler → stop旧→cache-bust reimport→start新 联动正确"
---

# P8: 订阅管理

## 目标

让脑可以在运行时动态管理订阅（启用/禁用/查询），
通过安全的原子工具操作 brain.json，不让 LLM 直接编辑 JSON。

## 依赖

- P3（FSWatcher + subscription-loader.reconcile）

## 可并行

P7 和 P8 可并行（都依赖 P3，互不依赖）。

## 核心设计

### 三个独立工具

```
subscribe({ name: "heartbeat", config?: { intervalMs: 5000 } })
→ brain.json enable[] 添加 "heartbeat", disable[] 移除
→ fs-watcher 触发 → reconcile → 启动 heartbeat

unsubscribe({ name: "stdin" })
→ brain.json disable[] 添加 "stdin", enable[] 移除
→ fs-watcher 触发 → reconcile → 停止 stdin

list_subscriptions()
→ { subscriptions: [
    { name: "stdin", status: "active", scope: "global" },
    { name: "heartbeat", status: "disabled", scope: "global" },
    { name: "my-monitor", status: "active", scope: "brain" }
  ] }
```

### 两种触发路径

```
路径 A（配置变更）：
  subscribe/unsubscribe 工具 → 安全写 brain.json
    → fs-watcher 检测 brain.json 变更
    → reconcile() diff → 启停差异项

路径 B（源码变更）：
  write_file 修改 subscriptions/*.ts
    → fs-watcher 检测 .ts 变更
    → stop 旧 source → import(`path?t=${Date.now()}`) → start 新 source
```

### 新增订阅类型 = 两步操作

```
① write_file({ path: "subscriptions/my-monitor.ts", content: "..." })
② subscribe({ name: "my-monitor" })
```

## brain.json subscriptions 语义

```json
{
  "subscriptions": {
    "default": "none",
    "enable": ["stdin", "my-custom-timer"],
    "disable": [],
    "config": {
      "my-custom-timer": { "intervalMs": 5000 }
    }
  }
}
```

| 键 | 作用范围 | 语义 |
|---|---------|------|
| `default` | 仅外部全局 | `"all"` 全局全开, `"none"` 全局全关 |
| `enable` | 外部+内部 | 显式启用 |
| `disable` | 外部+内部 | 显式禁用 |
| `config` | 外部+内部 | 传给 EventSourceFactory |

## 涉及文件

| 操作 | 文件 |
|------|------|
| 新建 | `tools/subscribe.ts` |
| 新建 | `tools/unsubscribe.ts` |
| 新建 | `tools/list_subscriptions.ts` |
