import { makeCapabilityTool } from "./_capability-utils.js";

export default makeCapabilityTool({
  name: "configure_tools",
  kind: "tools",
  subject: "tool definitions available to this brain",
});
