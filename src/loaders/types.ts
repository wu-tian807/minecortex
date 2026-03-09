import type { CapabilitySelector, CapabilitySource } from "../core/types.js";

export interface LoaderContext {
  brainId: string;
  brainDir: string;
  globalDir: string;
  selector: CapabilitySelector;
  capabilitySources: CapabilitySource[];
}
