import type { BrainContext } from '../core/types.js';

export interface ContextSlot {
  id: string;
  order: number;
  priority: number;
  condition?: () => boolean;
  content: string | (() => string);
  version: number;
}

export type SlotFactory = (ctx: SlotContext) => ContextSlot | ContextSlot[];

export type SlotContext = BrainContext;

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
