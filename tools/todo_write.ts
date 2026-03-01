import type { ToolDefinition, ToolOutput } from "../src/core/types.js";

type TodoStatus = "pending" | "in_progress" | "completed";

interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

const STATUS_ICON: Record<TodoStatus, string> = {
  pending: "⬜",
  in_progress: "🔄",
  completed: "✅",
};

function renderTodos(todos: TodoItem[]): string {
  const lines = todos.map(
    (t) => `- ${STATUS_ICON[t.status]} [${t.status}] ${t.content}`,
  );
  return `## Todos\n\n${lines.join("\n")}\n`;
}

export default {
  name: "todo_write",
  description:
    "Create or update a structured todo list. Renders as a markdown list " +
    "in the 'todos' dynamic slot so it remains visible across turns.",
  input_schema: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Unique todo identifier" },
            content: { type: "string", description: "Todo description" },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed"],
              description: "Current status",
            },
          },
          required: ["id", "content", "status"],
        },
        description: "Array of todo items to set",
      },
    },
    required: ["todos"],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const todos = args.todos as TodoItem[];
    if (!Array.isArray(todos) || todos.length === 0) {
      return "Error: todos must be a non-empty array.";
    }

    const rendered = renderTodos(todos);
    const existing = ctx.slot.get("todos");

    if (existing !== undefined) {
      ctx.slot.update("todos", rendered);
    } else {
      ctx.slot.register("todos", rendered);
    }

    const counts: Record<TodoStatus, number> = { pending: 0, in_progress: 0, completed: 0 };
    for (const t of todos) counts[t.status]++;

    return (
      `Updated ${todos.length} todo(s): ` +
      `${counts.completed} completed, ${counts.in_progress} in progress, ${counts.pending} pending.`
    );
  },
} satisfies ToolDefinition;
