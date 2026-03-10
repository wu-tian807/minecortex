function escapeForTemplate(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function renderWritePlanToolSource(parentBrainId: string, defaultName: string): string {
  const escapedParentBrainId = escapeForTemplate(parentBrainId);
  const escapedDefaultName = escapeForTemplate(defaultName);

  return `import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ToolDefinition, ToolOutput } from "../../../src/core/types.js";

const PARENT_BRAIN_ID = "${escapedParentBrainId}";
const DEFAULT_PLAN_NAME = "${escapedDefaultName}";

export default {
  name: "write_plan",
  description:
    "Write the current planning artifact into the parent brain workspace plans directory. " +
    "This overwrites the full file each time and uses the provided file name or the injected default.",
  input_schema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Optional plan file base name. If omitted, fall back to the injected default.",
      },
      contents: {
        type: "string",
        description: "The full markdown contents to write into the plan file",
      },
    },
    required: ["contents"],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const requestedName = sanitizeName(String(args.name ?? ""));
    const planName = requestedName || DEFAULT_PLAN_NAME;
    const planPath = ctx.pathManager.resolve({ path: \`plans/\${planName}.md\`, brain: PARENT_BRAIN_ID }, ctx.brainId);
    const contents = String(args.contents ?? "");
    await mkdir(dirname(planPath), { recursive: true });
    await writeFile(planPath, contents, "utf-8");
    return \`Wrote \${contents.length} bytes to \${planPath}\`;
  },
} satisfies ToolDefinition;

function sanitizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}
`;
}
