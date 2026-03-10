import type { ToolDefinition, ToolOutput } from "../../src/core/types.js";

type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

const BOARD_KEY = "todo-list";

const STATUS_ICON: Record<TodoStatus, string> = {
  pending: "○",
  in_progress: "▶",
  completed: "✓",
  cancelled: "✗",
};

function renderTodos(todos: TodoItem[]): string {
  if (todos.length === 0) return "";

  const total = todos.length;
  const done = todos.filter((t) => t.status === "completed").length;
  const cancelled = todos.filter((t) => t.status === "cancelled").length;
  const active = total - done - cancelled;

  const lines = todos.map((t) => {
    const icon = STATUS_ICON[t.status];
    return `  ${icon} [${t.id}] ${t.content}`;
  });

  return `## Todos (${done}/${active} completed)\n\n${lines.join("\n")}\n`;
}

export default {
  name: "todo_write",
  description:
    "Create or update a structured todo list. The list is persisted to BrainBoard " +
    "and rendered in system prompt via the 'todos' slot.\n\n" +
    "Use `merge: true` to incrementally update existing todos by id (add new or update changed properties).\n" +
    "Use `merge: false` to replace the entire list.\n" +
    "Use `clear: true` to remove all todos entirely.\n\n" +
    "Status values: pending, in_progress, completed, cancelled.\n" +
    "Keep exactly ONE task in_progress at a time.",
  input_schema: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Unique todo identifier" },
            content: {
              type: "string",
              description: "Todo description (can be omitted when only updating status)",
            },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed", "cancelled"],
              description: "Current status",
            },
          },
          required: ["id"],
        },
        description: "Array of todo items to create or update (ignored if clear=true)",
      },
      merge: {
        type: "boolean",
        description:
          "If true, merge with existing todos by id. If false, replace entire list. Ignored if clear=true.",
      },
      clear: {
        type: "boolean",
        description:
          "If true, remove all todos entirely. The todos slot will no longer be shown.",
      },
    },
    required: [],
  },

  async execute(args, ctx): Promise<ToolOutput> {
    const board = ctx.brainBoard;
    const brainId = ctx.brainId;

    if (args.clear === true) {
      board.remove(brainId, BOARD_KEY);
      const existing = ctx.slot.get("todos");
      if (existing !== undefined) {
        ctx.slot.release("todos");
      }
      return "Cleared all todos.";
    }

    const incoming = args.todos as Partial<TodoItem>[] | undefined;
    const merge = args.merge as boolean;

    if (!Array.isArray(incoming) || incoming.length === 0) {
      return "Error: todos must be a non-empty array (or use clear=true to remove all).";
    }

    let current = (board.get(brainId, BOARD_KEY) as TodoItem[]) ?? [];

    if (merge) {
      for (const item of incoming) {
        if (!item.id) {
          return `Error: each todo must have an 'id' field.`;
        }
        const idx = current.findIndex((t) => t.id === item.id);
        if (idx >= 0) {
          if (item.content !== undefined) current[idx].content = item.content;
          if (item.status !== undefined) current[idx].status = item.status;
        } else {
          if (!item.content || !item.status) {
            return `Error: new todo '${item.id}' requires both 'content' and 'status'.`;
          }
          current.push({
            id: item.id,
            content: item.content,
            status: item.status,
          });
        }
      }
    } else {
      current = incoming.map((t) => {
        if (!t.id || !t.content || !t.status) {
          throw new Error(`Todo requires id, content, and status. Got: ${JSON.stringify(t)}`);
        }
        return { id: t.id, content: t.content, status: t.status };
      });
    }

    board.set(brainId, BOARD_KEY, current);

    const rendered = renderTodos(current);
    const existing = ctx.slot.get("todos");
    if (rendered) {
      if (existing !== undefined) {
        ctx.slot.update("todos", rendered);
      } else {
        ctx.slot.register("todos", rendered);
      }
    } else if (existing !== undefined) {
      ctx.slot.release("todos");
    }

    const counts: Record<TodoStatus, number> = {
      pending: 0,
      in_progress: 0,
      completed: 0,
      cancelled: 0,
    };
    for (const t of current) counts[t.status]++;

    return (
      `Updated ${current.length} todo(s): ` +
      `${counts.completed} completed, ${counts.in_progress} in progress, ` +
      `${counts.pending} pending, ${counts.cancelled} cancelled.`
    );
  },
} satisfies ToolDefinition;
