import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import type { ToolDefinition, ToolOutput } from "../src/core/types.js";

const ROOT = process.cwd();

const DEFAULT_BRAIN_JSON = {
  model: null,
  subscriptions: { global: "none", enable: ["stdin"] },
  tools: { global: "all", disable: ["create_brain", "manage_brain"] },
  slots: { global: "all" },
};

function defaultSoul(id: string): string {
  return `# ${id}

你是 MineClaw 多脑系统中的 ${id} 脑区。

## 职责
- (请编辑此处)

## 约束
- 默认中文回复，代码注释用英文
- 每步完成后简短汇报

## 关系
- 通过 send_message 与其他脑区协作
- 用 manage_brain list 查看系统中所有活跃脑区

## 工作方式
1. 理解任务 → 拆解步骤
2. 用工具直接执行
3. 遇到问题先自己排查
`;
}

export default {
  name: "create_brain",
  description:
    "Create a new brain directory under brains/<id>/ with brain.json and soul.md. " +
    "Fails if the brain directory already exists.",
  input_schema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "Unique brain identifier (used as directory name)",
      },
      model: {
        type: "string",
        description: "Model override for brain.json",
      },
      soul: {
        type: "string",
        description: "Custom soul.md content. Uses default template if omitted.",
      },
      subscriptions: {
        type: "object",
        description: "Custom subscriptions selector for brain.json",
      },
    },
    required: ["id"],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const id = String(args.id);

    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      return `Error: invalid brain id '${id}'. Use only alphanumeric, dash, underscore.`;
    }

    const brainDir = join(ROOT, "brains", id);

    try {
      await access(brainDir);
      return `Error: brain directory already exists: brains/${id}/`;
    } catch {
      // doesn't exist — proceed
    }

    await mkdir(brainDir, { recursive: true });

    const brainJson = { ...DEFAULT_BRAIN_JSON } as Record<string, unknown>;
    if (args.model) brainJson.model = String(args.model);
    if (args.subscriptions) brainJson.subscriptions = args.subscriptions;

    const brainJsonPath = join(brainDir, "brain.json");
    await writeFile(brainJsonPath, JSON.stringify(brainJson, null, 2) + "\n", "utf-8");

    const soulContent = args.soul ? String(args.soul) : defaultSoul(id);
    const soulPath = join(brainDir, "soul.md");
    await writeFile(soulPath, soulContent, "utf-8");

    return JSON.stringify({ ok: true, id, path: `brains/${id}` });
  },
} satisfies ToolDefinition;
