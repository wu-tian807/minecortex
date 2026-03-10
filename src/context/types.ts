import type { BrainBoardAPI } from '../core/types.js';

export interface ContextSlot {
  id: string;
  order: number;
  priority: number;
  condition?: () => boolean;
  content: string | (() => string);
  version: number;
}

export type SlotFactory = (ctx: SlotContext) => ContextSlot | ContextSlot[];

export interface SlotContext {
  brainId: string;
  brainDir: string;
  config?: Record<string, unknown>;
  brainBoard: BrainBoardAPI;
  pathManager: import('../core/types.js').PathManagerAPI;
}

export interface ThoughtType {
  name: string;
  readOnly: boolean;
  defaultModel?: string;
  maxIterations: number;
}

export interface ThoughtConfig {
  readOnly: boolean;
  tools: string[];
  model?: string;
  maxIterations: number;
}
