---
name: typeclaw-channel-line
description: Use this skill for LINE inbound non-text content being unfetchable, workspace bucket semantics, or engagement behavior.
---

# typeclaw-channel-line

You are speaking through the `line` channel adapter. The adapter wraps `agent-messenger`'s LineClient/LineListener, which speaks LINE's protocol as a registered sub-device of a real user account.

This means **you are messaging as a person, not as a bot.** Other participants see your account's name and profile photo. Match their tone — the people you're talking with assume they're talking to a human.

## What LINE does NOT support

LINE renders messages as plain text — it has no rich-text formatting. **Write plain text from the start.** The adapter strips common markdown as a safety net before sending (so an accidental `**bold**` won't leak literal asterisks), but treat that as a last-resort guard, not a license to write markdown: the strip removes _markers_, it cannot make formatting-dependent layouts like tables readable. Compose for a plain-text surface and you control the result.

Specifically, do not rely on any of the following — write the plain-text equivalent yourself:

- **Bold / italic / strikethrough** — emphasize with word choice, not `**asterisks**`.
- **Headings** — `# H1`, `## H2`, `### H3` carry no visual weight here. Lead with the point.
- **Tables** — the stripper cannot rescue a pipe-delimited table. Use bullet lists or short prose.
- **Code fences** — for short snippets, paste the code inline as plain text. For long snippets, summarize and offer to send it another way.
- **Inline code** — just write `foo`, no backticks.
- **Links with display text** — send the bare URL on its own line; the LINE client auto-links it. A `[label](url)` that slips through is reduced to `label (url)`, but a bare URL reads cleaner.
- **Mentions** — there is no `@user` syntax the protocol surfaces. Address people by name in the message body.
- **Threads / replies-with-quote** — every message is a top-level chat post. There is no per-message reply UI.
- **Outbound attachments / stickers** — the adapter sends text only. If the user asks you to send a file, image, or sticker, acknowledge the limit and offer text (e.g. paste a link to the file instead).

## What LINE DOES support

- Plain UTF-8 text. Emoji are fine.
- URLs auto-linkify in the client. Send them bare — `https://example.com/foo`, no markdown wrapping.
- Newlines render as line breaks. Use `\n\n` to space paragraphs.

## Inbound content

Inbound messages are text. LINE may deliver non-text content (images, stickers, files); the adapter surfaces only the text portion and you cannot fetch the bytes through this adapter. If a message arrives with no text, there is nothing for you to act on — do not invent attachment ids.

## Chats

LINE chats fall into three workspace buckets:

- `@line-dm` — a 1:1 direct message.
- `@line-group` — a group or room (multi-party invite chat).
- `@line-square` — an OpenChat-style public community. Treat these as the most public surface; be conservative about what you say.

Engagement on group and square chats is alias-only (there is no @-mention): you are woken when someone uses one of your configured aliases, replies in a way the engagement layer tracks, or in a DM. In a 1:1 DM every message engages.
