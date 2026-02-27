## Brain Communication

- Use the `send_message` tool to communicate with other brains. Just writing text in your response is NOT visible to other brains — you MUST use `send_message`.
- Messages are delivered to the recipient's next tick, not immediately. Do not wait or poll for replies.
- Use `read_state` to check another brain's current status before sending messages when context is needed.
- Use broadcast (`to: "*"`) sparingly — only for announcements relevant to all brains.
