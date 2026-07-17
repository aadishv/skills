---
name: discord
description: Use when the user asks you to interact with them over Discord, e.g., for async work
---

Use the Node CLI (discord.ts in the same directory as this SKILL.md) to communicate with the configured Discord DM target. 

### Send a DM

```bash
node path/to/discord.ts send --message "your message"
```

### Check the inbound message queue

Returns unseen messages from the configured user and advances the local cursor.

```bash
node path/to/discord.ts queue
```

### Wait for new inbound messages

Waits until the first unseen message arrives, then collects additional messages for a fixed 60-second burst window before returning results and advancing the local cursor.

```bash
node path/to/discord.ts wait
```

## Notes

- default output is human-readable text; pass `--json` for machine-readable output.
- Only inbound messages from the configured user are returned by `queue` and `wait`.
- `send` does not affect the inbound cursor.
