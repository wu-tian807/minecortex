/** @desc LLM 入口 — import 触发所有适配器自注册 */

import "./gemini.js";
import "./anthropic.js";
import "./openai-compat.js";

export { createProvider, registerProvider, parseModelSpec } from "./provider.js";
