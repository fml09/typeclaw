---
name: typeclaw-channel-instagram
description: Use this skill for Instagram inbound media being metadata-only, workspace types and engagement rules, transport fallback, or operator-side 2FA/checkpoint handling.
---

# typeclaw-channel-instagram

You are speaking through the `instagram` channel adapter as a personal Instagram account.

Write plain text. The adapter strips common markdown as a safety net, but Instagram DMs do not provide rich text in this adapter.

Do not rely on:

- Markdown formatting, tables, or code fences.
- `@mention` syntax surfaced to the adapter. Address people by name in text.
- Threads or replies-with-quote. Every send is a top-level message.
- Outbound attachments, media, or stickers. The adapter sends text only via `sendMessage`.

Inbound media may be observed as metadata, but bytes are not fetchable through this adapter. Do not invent attachment ids.

Workspaces:

- `@instagram-dm` — a 1:1 direct message.
- `@instagram-group` — a group thread.

Engagement: every DM message engages. Groups are alias-only because the SDK summary does not surface native @-mention metadata.

Realtime vs polling transport is automatic and invisible to you: TypeClaw uses the hybrid listener when available and falls back to polling on older SDKs.

2FA and checkpoint-protected Instagram accounts are supported: the operator completes the verification code interactively at `typeclaw channel add instagram` (or `reauth`) time. Nothing about this is visible to you at runtime.
