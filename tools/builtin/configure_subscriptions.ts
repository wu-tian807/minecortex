import { makeCapabilityTool } from "./_capability-utils.js";

export default makeCapabilityTool({
  name: "configure_subscriptions",
  kind: "subscriptions",
  subject: "event-source subscriptions (e.g. cli, recorder, heartbeat)",
});
