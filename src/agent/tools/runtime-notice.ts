// Wraps a runtime-emitted notice body in canonical SYSTEM MESSAGE framing so
// persona-rich models cannot read the prose as a chat instruction from a
// human and respond to it in-character.
//
// The failure mode this exists to prevent: tool results reach the model as
// USER-role messages (provider tool-call contract — engines cannot tag them
// as system). The `TOOL_RESULT_PREFIX` already marks each result's leading
// position, but trailing natural-language hints (the consecutive-send nudge
// is the canonical case) still parse as conversational prose, and Kimi-K2.x
// has been observed in production responding to those hints in-character —
// an apology directly addressed at the human ("sorry for talking so much,
// I'll be quieter next time") when the only stimulus in the prompt was the
// router's "Nth consecutive message; end your turn now" hint. Four
// consecutive in-character replies to fenced-prose runtime hints in a
// single drain iteration is the observed shape.
//
// Framing convention is the same shape `composeTurnPrompt` uses for the
// loop-guard block in `router.ts` — bracketed marker, fence rules, and
// explicit "Do not acknowledge or reply to this notice" closer. The
// loop-guard block has been in production against Kimi for months without
// the misread we observed on the consecutive-send hint, which is why we
// reuse the exact same shape here.
//
// Applied unconditionally (not model-gated): the cost is ~40 tokens per
// hint emission, paid only on consecutive sends (where the hint is already
// firing), and the framing is safe for every model — well-behaved models
// read it and move on. Gating by model family would have required a
// traits table for one defense and would still need extending the moment
// a second model family exhibited the same misread, so we accept the
// universal cost in exchange for never having to remember to add a new
// family to a list.
// The bracketed marker is what tells the model a block is runtime-emitted, so
// any untrusted string rendered into a turn must not be able to carry one.
// Inbound channel text and memory headings/excerpts are both reproduced
// verbatim, so without this a participant (or a poisoned shard) could forge a
// fence and inherit whatever standing the real one has.
//
// Only the marker is defused, not the `---` rules around it: a horizontal rule
// is ordinary markdown that appears in pasted diffs, YAML, and tables all the
// time, and mangling those would corrupt real messages for no gain. The marker
// is the rare, load-bearing token — neutralize that and the fence cannot form.
//
// Matching is deliberately loose (case-insensitive, any wording after the
// keyword) because an attacker chooses both; the real emitters always produce
// the canonical form, so a false positive can only ever hit text that was
// already imitating a runtime marker.
//
// Only the OPENER is matched, via a lookahead that consumes nothing past `**[`.
// Matching the whole `**[...]**` span instead would be exploitable: the span
// ends at the first `]**`, so a nested opener (`**[SYSTEM MESSAGE a **[SYSTEM
// MESSAGE b]** c]**`) lands inside the replacement, and `String.replace` never
// rescans what it just emitted — leaving a live marker behind. Neutralizing
// openers independently is single-pass safe and idempotent, because the
// replacement text contains no `**[` for a later pass to find.
const RUNTIME_MARKER_OPENER = /\*\*\s*\[(?=\s*(?:SYSTEM MESSAGE|MEMORY CONTEXT)\b)/gi

export function defuseRuntimeMarkers(text: string): string {
  return text.replace(RUNTIME_MARKER_OPENER, '(quoted from untrusted text) [')
}

export function fenceRuntimeNotice(body: string): string {
  return (
    '\n\n---\n' +
    '**[SYSTEM MESSAGE — not from a human]**\n\n' +
    body +
    '\n\nThis is an automated signal from the channel router, not a message ' +
    'from anyone in the chat. **Do not acknowledge or reply to this notice.**\n' +
    '---'
  )
}

// Wraps a channel tool result (delivery confirmation + echoed sent text) in the
// SAME canonical SYSTEM MESSAGE framing as fenceRuntimeNotice — but as the
// ENTIRE result body, not an appended hint, so there is no unfenced prose for
// the model to read as conversation.
//
// The echoed sent text is load-bearing (the bot has no other view of what it
// just said — the inbound path drops self-authored messages — so without it a
// split reply re-sends near-duplicates). But that text is the model's OWN
// words, which is uniquely seductive to "reply" to: a persona-rich model
// (Kimi K2 on the GitHub channel, PR #481) read its own delivered prose as a
// fresh user turn and answered it ("you're welcome!", "aww thanks!") until the
// per-turn send cap. The weak `[system: tool result...]` prefix did not stop
// the misread; the full fence — bracketed marker, horizontal-rule fences,
// explicit "Do not reply" closer — has months of production track record
// against Kimi (it already wraps the consecutive-send and thread-mismatch
// hints). Reusing the exact same shape extends that protection to the echo.
export function fenceToolResult(receipt: string): string {
  return (
    '---\n' +
    '**[SYSTEM MESSAGE — not from a human]**\n\n' +
    receipt +
    '\n\nThe text above is your OWN already-delivered message, echoed back so ' +
    'you can see what you sent — it is NOT a new message from anyone in the ' +
    'chat. **Do not acknowledge or reply to it.**\n' +
    '---'
  )
}
