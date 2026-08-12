import type { LoadableSkill } from '@/plugin'

export const DOC_REVIEW_SKILL_NAME = 'doc-review'

export const DOC_REVIEW_SKILL_DESCRIPTION =
  'Review a document written to inform or instruct a reader. Covers purpose and audience fit, completeness for the stated job, accuracy of examples and claims, navigability, staleness, terminology consistency, and accessibility — for any kind of document, with a scoped lens for technical docs when the target is one.'

export const DOC_REVIEW_SKILL_CONTENT = `# doc-review

You have been asked to review a document — anything written to inform or instruct a reader. Do not assume a kind. The craft below is universal and applies whatever the document turns out to be; the technical-docs section near the end is one specialization you apply only when the target is in fact developer documentation. Read the target, let it tell you what it is, and review it on its own terms. Apply all of this on top of the reviewer's neutral output contract (severity-tagged findings, evidence quotes, suggestions, verdict).

## How to acquire the target

- **A file path** — \`read\` it. \`ls\` the surrounding directory to see how this page fits the larger set; a document is reviewed in the context of the set it belongs to.
- **A URL** — \`web_fetch\` it. If it is a private site the fetch cannot reach, say so in \`<summary>\` and review what the payload provided.
- **A PR or diff that touches docs** — use \`gh pr diff <n>\` for a small change. When broad local context is needed, call \`github_prepare_review_checkout\` once for initial acquisition with the repo slug and 40-character head SHA, then use the returned receipt path exactly for batched \`read\`/\`grep\`/\`find\` calls. If and only if a read-only operation against that exact returned receipt path fails with \`ENOENT\` / \`No such file or directory\`, call the checkout tool one additional time with the same exact repo slug and 40-character head SHA, then use only the new returned receipt. This is a maximum two checkout tool calls; never retry generic command, tool, or provider failures or change coordinates. Never guess or reconstruct a path or acquire a checkout with bash. If recovery also fails, stop checkout attempts and fall back to remote reads where feasible or return an honest incomplete review.
- **A doc set / directory** — \`ls\` and \`grep\` for the navigation or index file; a finding about findability needs the table of contents, not just one page.
- **Verify external claims.** If the document cites a law, a standard, a price, an SLA, a statistic, or a linked source, check it with \`web_search\`/\`web_fetch\` before letting it stand.

## State the document's job before reading for defects

Every document exists to let a specific reader do or understand a specific thing. Before looking for problems, answer two questions and hold them while you read: **Who is this for?** and **What should they be able to do or know after reading it?** Most documentation defects are a mismatch between the page and the answer to one of those. A finding is strongest when it names which reader the document fails and why. This is your private grounding — keep the restatement out of \`<summary>\`.

## What to look for

These apply to any document:

1. **Purpose / audience fit.** The document is pitched at the wrong reader: jargon and unexplained acronyms for a lay audience, or hand-holding for an expert one; a policy written for lawyers handed to new hires. Name the mismatch.
2. **Completeness for the stated job.** A missing step, an undocumented edge case, a process that stops before the reader's actual goal, a policy that does not say what happens on violation. The gap is a finding when it leaves the reader unable to finish what the document promised.
3. **Accuracy of examples and claims.** Anything the document asserts as fact must be correct: a quoted figure, a referenced rule or standard, a worked example, a screenshot, a sample. A wrong example or an unsupported load-bearing claim is a real defect regardless of document type — for code docs this means samples that do not run; for a policy it means a cited regulation that says something else.
4. **Missing prerequisites or assumptions.** The document assumes access, a prior step, a role, a tool, or background the reader does not have and is never told to get. State the assumption the reader cannot meet.
5. **Navigability / findability.** A page unreachable from the index, no clear next step where the reader needs one, no anchor for the thing a reader will search for, a long document with no structure to scan. Hard-to-navigate is a defect when it blocks the reader from reaching the part they need.
6. **Broken or stale cross-references.** Links that 404, "see the section below" pointing at a section that no longer exists, references to a renamed page or a superseded policy version.
7. **Staleness.** Content that describes an older state than the one in force: an old release's flags, a deprecated process, a price or date that has moved, a screenshot of a UI that changed. Cite the current value against the stale one.
8. **Terminology / consistency.** The same concept called several names with no statement they are the same ("workspace" / "project" / "folder"; "member" / "user" / "seat"). Pick the canonical term and flag the drift.
9. **Accessibility.** Images with no alt text, heading levels that skip (h1 → h3), meaning carried by color alone, bare "click here" link text. Real findings, not nits, when they block a reader using assistive tech.

## When the target is technical documentation

Developer docs have a failure mode worth naming explicitly: the page is the wrong *type* for what the reader needs. When reviewing technical docs, classify the page against the four Diátaxis modes, because the right content for one is wrong for another:

- **Tutorial** — learning-oriented. A guaranteed-to-succeed lesson for a newcomer. Concrete, linear, no detours.
- **How-to guide** — task-oriented. Steps to achieve one stated goal for someone who already knows the basics.
- **Reference** — information-oriented. Dry, complete, accurate description of the API/CLI/config. No teaching.
- **Explanation** — understanding-oriented. The "why" and the trade-offs. No step-by-step.

A page that mixes modes — a tutorial padded with architecture explanation, a reference that drifts into opinion — fails the reader who came for one of them. For technical docs, also hold examples to a higher bar: a code sample is a *claim that it runs*, so trace it against the real CLI/API surface (\`read\` the source, \`gh pr diff\`, the changelog) and cite any sample that uses a removed flag, a wrong import, or a renamed subcommand. This Diátaxis lens and runnable-sample check do NOT apply to non-technical documents — do not force a policy or an onboarding page into a "tutorial vs reference" frame.

## What NOT to find

- **Formatter / linter territory.** Trailing whitespace, line length, fenced-block language tags, table alignment. Assume a docs linter ran.
- **House-style the page follows.** Second person, sentence-case headings, "e.g." vs "for example" — if the document is consistent with its house style, that is not a finding. Only the deviation is.
- **Restating the document as a finding.** "This page documents the start command" / "this policy covers expenses" is not a review.
- **Rewriting for taste.** A sentence you would have phrased differently but that reads clearly for its reader is not a finding. Clarity is the bar, not your preferred cadence.
- **Generic "add more examples" / "make it clearer".** Without naming the specific step, field, or passage that is under-documented or unclear, it is noise.

## Severity hints specific to docs

- **blocker** — An example or claim that is factually wrong and will lead the reader astray (a sample that fails for everyone, a cited rule that says the opposite). A prerequisite gap that strands the reader at step one. An audience mismatch so severe the intended reader cannot use the document at all.
- **concern** — A stale reference that still mostly works but will mislead, a missing prerequisite for a later step, a completeness gap that blocks an edge case, terminology drift that will confuse a newcomer, an accessibility defect that degrades but does not block.
- **nit** — A single awkward sentence, a missing "next step" link, a minor terminology wobble in an aside. Optional.
- **praise** — A document that genuinely lands its reader: a tutorial that reaches a working state, a policy that is unambiguous on the hard case, an explanation that makes a difficult concept click. Rare.

## Verdict mapping

- **approve** — Publishable. The document serves its reader; any gaps are nits.
- **request-changes** — At least one blocker: a wrong example or claim, an audience mismatch that defeats the purpose, a prerequisite gap that strands the reader.
- **comment** — Useful observations without a clean accept/reject. Common for an early draft or a partial review of a large doc set.

## Final output

Return findings inside the reviewer's neutral \`<review>\` block. Do NOT invent your own output format.
`

export const DOC_REVIEW_SKILL: LoadableSkill = {
  name: DOC_REVIEW_SKILL_NAME,
  description: DOC_REVIEW_SKILL_DESCRIPTION,
  content: DOC_REVIEW_SKILL_CONTENT,
}
