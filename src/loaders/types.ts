import type { CapabilitySelector, CapabilitySource, PathManagerAPI } from "../core/types.js";

export interface LoaderContext {
  brainId: string;
  brainDir: string;
  /** 用于路径解析和权限判断；root() 替代了原先的 globalDir */
  pathManager: PathManagerAPI;
  selector: CapabilitySelector;
  capabilitySources: CapabilitySource[];
}
