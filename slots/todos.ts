import type { SlotFactory, ContextSlot } from "../src/context/types.js";

const BOARD_KEY = "todo-list";
const SLOT_ORDER = 50;
const SLOT_PRIORITY = 8;

type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

const STATUS_ICON: Record<TodoStatus, string> = {
  pending: "○",
  in_progress: "▶",
  completed: "✓",
  cancelled: "✗",
};

function renderTodos(todos: TodoItem[]): string {
  if (!todos || todos.length === 0) return "";

  const total = todos.length;
  const done = todos.filter((t) => t.status === "completed").length;
  const cancelled = todos.filter((t) => t.status === "cancelled").length;
  const active = total - done - cancelled;

  const lines = todos.map((t) => {
    const icon = STATUS_ICON[t.status];
    return `  ${icon} [${t.id}] ${t.content}`;
  });

  return `## Current Todos (${done}/${active} completed)\n\n${lines.join("\n")}\n`;
}

const create: SlotFactory = (ctx): ContextSlot => {
  const { brainId, brainBoard } = ctx;

  return {
    id: "todos",
    order: SLOT_ORDER,
    priority: SLOT_PRIORITY,
    condition: () => {
      const todos = brainBoard.get(brainId, BOARD_KEY) as TodoItem[] | undefined;
      return Array.isArray(todos) && todos.length > 0;
    },
    content: () => {
      const todos = brainBoard.get(brainId, BOARD_KEY) as TodoItem[] | undefined;
      return renderTodos(todos ?? []);
    },
    version: 0,
  };
};

export default create;
