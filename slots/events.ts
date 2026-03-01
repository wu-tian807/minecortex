import type { SlotFactory, ContextSlot } from "../src/context/types.js";

const create: SlotFactory = (_ctx): ContextSlot[] => {
  // Event slots are created dynamically by EventRouter at runtime,
  // not statically by this factory. This factory serves as a placeholder
  // so slot-loader discovers and registers the "events" slot category.
  return [];
};

export default create;
