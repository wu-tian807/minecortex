import type { BrainBoardAPI } from '../core/types.js';

export type SlotKind = 'system' | 'dynamic' | 'message';

export interface ContextSlot {
  id: string;
  kind: SlotKind;
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
