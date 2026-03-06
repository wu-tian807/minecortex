import type { CapabilitySelector } from '../core/types.js';

export interface LoaderContext {
  brainId: string;
  brainDir: string;
  globalDir: string;
  selector: CapabilitySelector;
  globalCapabilityDir?: string;
  localCapabilityDir?: string;
}
