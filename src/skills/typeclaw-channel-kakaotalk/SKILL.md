---
name: typeclaw-channel-kakaotalk
description: Use this skill for KakaoTalk inbound attachment/emoticon handling with `channel_fetch_attachment` or `look_at_channel_attachment`, outbound attachment/gallery MIME routing, engagement/stickiness and group-chat permission questions, mark-read behavior, or self-loop troubleshooting.
---

# typeclaw-channel-kakaotalk

You are speaking through the `kakaotalk` channel adapter. The adapter wraps `agent-messenger`'s KakaoTalkClient/KakaoTalkListener, which speaks KakaoTalk's LOCO push protocol as a registered tablet sub-device of a real user account.

This means **you are messaging as a person, not as a bot.** Other participants see your typeclaw account's name and profile photo. Match their tone — the people you're talking with assume they're talking to a human.

## What KakaoTalk does NOT support

KakaoTalk renders messages as plain text — it has no rich-text formatting. **Write plain text from the start.** The adapter strips common markdown as a safety net before sending (so an accidental `**bold**` won't leak literal asterisks), but treat that as a last-resort guard, not a license to write markdown: the strip removes _markers_, it cannot make formatting-dependent layouts like tables readable. Compose for a plain-text surface and you control the result; lean on the stripper and you get whatever falls out.

Specifically, do not rely on any of the following — write the plain-text equivalent yourself:

- **Bold / italic / strikethrough** — emphasize with word choice or capitalization (sparingly), not `**asterisks**`.
- **Headings** — `# H1`, `## H2`, `### H3` carry no visual weight here. Use a short label line or just lead with the point.
- **Tables** — the stripper cannot rescue a pipe-delimited table; it would collapse into an unreadable line. Use bullet lists or short prose paragraphs instead.
- **Code fences** — for short snippets, paste the code inline as plain text. For long snippets, summarize and offer to send it via another channel.
- **Inline code** — just write `foo`, no backticks.
- **Links with display text** — send the bare URL on its own line; the KakaoTalk client auto-links it. (A `[label](url)` that slips through is reduced to `label (url)`, but a bare URL reads cleaner.)
- **Mentions** — there is no `@user` syntax that the protocol surfaces. Address people by name in the message body.
- **Threads / replies-with-quote** — every message is a top-level chat post. There is no per-message reply UI.
- **Outbound stickers / emoticons** — the KakaoTalk sticker store requires desktop-app purchase flows that the SDK does not replicate. Inbound stickers ARE surfaced (see below), but you cannot send one. If the user asks for a sticker, acknowledge the limit and offer text.

## What KakaoTalk DOES support

- Plain UTF-8 text. Emoji are fine.
- URLs auto-linkify in the client. Send them bare — `https://example.com/foo`, no markdown wrapping.
- Newlines render as line breaks. You can use `\n\n` to space paragraphs.
- **Outbound file attachments** — photos, videos, audio, generic files, and multi-photo galleries. Pass each as an `OutboundAttachment { path, filename? }` on the `attachments[]` field of `channel_send` / `channel_reply`. The adapter sniffs the MIME from the filename and routes to the right KakaoTalk message type, so the caller does not pick photo-vs-file-vs-multiphoto by hand:
  - Single attachment → single send. `image/*` renders inline with tap-to-zoom; `video/*` as an inline player; `audio/*` as a voice bubble; everything else as a downloadable file.
  - Multiple attachments, all image MIMEs → multi-photo gallery (one chat bubble containing every image).
  - Multiple attachments with mixed kinds (e.g. photo + PDF) → individual sends, one bubble each, in array order.
  - Each send is fail-fast: if any upload fails the adapter returns `ok: false` immediately rather than partial-success.
- **Text + attachments in one `channel_send`** — files upload first, then the text posts as a separate chat bubble. KakaoTalk has no Slack-style `initial_comment` that lets text and files share a single send.

## Inbound attachments and stickers

Even though you cannot SEND stickers, you DO receive attachments and stickers. The adapter surfaces incoming non-text content by appending a ref-free `[KakaoTalk attachment #N: <kind> <metadata>]` placeholder to the inbound text (same convention as Slack/Discord/Telegram). Examples of what you'll see:

- A photo (with no caption): `[KakaoTalk attachment #1: photo 1320x2868 image/jpeg]`
- A photo with a caption: `look at this\n[KakaoTalk attachment #1: photo 1320x2868 image/jpeg]`
- A file: `[KakaoTalk attachment #1: file application/pdf name=spec.pdf size=12345]`
- A video / audio / multiphoto: `[KakaoTalk attachment #1: video video/mp4]` or `[KakaoTalk attachment #1: multiphoto]`
- A sticker / emoticon: `[KakaoTalk attachment #1: sticker name=4412724.emot_001.webp]`

### Fetching attachment bytes

For photos, files, and any video / audio / multiphoto with an attachment token, call `channel_fetch_attachment` with the numeric `attachment_id` from the token to download the bytes. To view an image directly, call `look_at_channel_attachment` with the same `attachment_id`.

Use this when you actually need to look at the content — e.g. the user sends a screenshot and asks "what's in this?". The download lands in your inbox directory and you can pass it to a vision-capable inspection tool or read it directly depending on the file type.

If no attachment token appears in the inbound text, no attachment was sent. Do not invent attachment ids — the tool will reject ids that do not appear in the current turn.

**Stickers cannot be fetched** as bytes through this tool. Treat stickers as descriptive metadata only — acknowledge them ("cute sticker") without trying to "see" them.

If the inbound text is JUST a sticker (no accompanying text), the agent still gets a routed event — stickers count as engagement under `reply` and `dm` triggers (group chats with only sticker activity will not trigger `mention` because aliases require text matching).

## Message length & cadence

KakaoTalk is mobile-first. The reading surface is small and the user is on their phone. Keep messages **short and conversational**, not essay-length. If you have a long answer:

1. Lead with a one-sentence summary.
2. Optional: 2–4 short bullet-style lines (use `-` or `•` as line prefixes — the client renders them as text, not lists, but the visual rhythm still helps).
3. Stop. If the user wants more, they will ask.

Splitting one logical answer across multiple messages is fine and often more natural than one wall of text.

## Engagement model

The adapter exposes three engagement triggers via `channels.kakaotalk.engagement.trigger` in `typeclaw.json`:

- `dm` — every message in a 1:1 chat. Default-on.
- `reply` — every message in a chat where you sent the previous message. Default-on.
- `mention` — KakaoTalk has no mention syntax in the protocol. The adapter reads this trigger as "respond when an alias from `alias[]` in `typeclaw.json` appears in the text". Without configured aliases, this trigger never fires.

Stickiness behaves the same as Slack/Discord: once you've engaged in a chat, follow-up messages within `engagement.stickiness.perReply.window` ms will route to you regardless of trigger.

If you find yourself NOT receiving messages you expect to, the most likely cause is missing role coverage in `roles.<role>.match[]`. KakaoTalk's match-rule grammar:

- `kakao:*` — every chat the account can see (use sparingly: this is every group and DM you are a member of)
- `kakao:dm/*` — every 1:1 chat
- `kakao:group/*` — every multi-person group chat
- `kakao:open/*` — every open chat
- `kakao:<chat-id>` — a specific chat by numeric chat_id

Group chats with personal accounts are sensitive — every member sees every reply. Be conservative when widening match-rules: a `kakao:group/*` entry on a permissive role exposes the agent in every group the account is a member of. See the `typeclaw-permissions` skill.

## Mark read on every inbound

The adapter sends a LOCO `NOTIREAD` ack to KakaoTalk for every inbound message event it observes. The sender's unread "1" (노란숫자) clears in their client as soon as the agent's container receives the bytes. This is always-on — there is no config flag to turn it off short of editing the source. (An earlier `channels.kakaotalk.autoMarkRead` opt-in field was removed; existing configs still parse but the field is ignored.)

Things to know about this behavior:

- Auto-acking every received message is a distinct behavioral fingerprint compared to a human. A human reads messages when they open the chat; this adapter acks every received message instantly, even ones you never reply to. KakaoTalk's abuse detection may flag accounts that ack rapidly and unconditionally. **Run the kakaotalk adapter only on dedicated agent accounts you can afford to lose.**
- Dropped messages are still acked. If classify drops the message (your own self-sent loopback, empty text, unknown chat), or the router drops it on the `channel.respond` gate, the unread "1" still clears — the agent has observed the bytes, so the read indicator should match.
- Open chats (오픈채팅) are skipped: the LOCO `NOTIREAD` packet needs a `linkId` for open chats and the adapter doesn't surface it yet. Unread counters in open chats will not decrement.
- The phone's home-screen OS unread badge may lag until the phone client foregrounds; the in-chat counter and other participants' indicators update immediately. KakaoTalk client quirk, not a typeclaw bug.

If a markRead call fails (network blip, non-success status from the server, container shutdown), it is logged at warn level (`[kakaotalk] mark-read failed: ...`) and silently moves on — message delivery is never blocked by an ack failure.

## Self-loop guard

The adapter drops every inbound where `event.author_id` equals the logged-in account's `user_id`. Two typeclaw agents talking to each other through KakaoTalk would otherwise loop indefinitely (KakaoTalk has no bot-flag, so neither side can detect the other is automated). Do not try to defeat this guard.

## When you cannot answer in KakaoTalk

If the user asks you to do something the adapter cannot do (post in a thread, send a sticker, render a real table), say so plainly. Files are fine — those go through `attachments[]` as described above — but threading, stickers, and rich formatting are real limits. Markdown markers you emit get stripped to plain text automatically, so a stray `**` won't leak; the limit is that nothing renders as formatting, not that it crashes. Acknowledge the limit instead of silently dropping the request.
