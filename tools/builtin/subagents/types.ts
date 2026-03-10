export type SubagentType = "observe" | "plan" | "act";
export type ContextMode = "none" | "summary" | "full";
export type SubagentMode = "foreground" | "background";
export type SubagentAction = "launch" | "reply";
export type SubagentEffort = "low" | "medium" | "high";

export const SUBAGENT_QUESTION_MARKER = "[subagent_question]";
