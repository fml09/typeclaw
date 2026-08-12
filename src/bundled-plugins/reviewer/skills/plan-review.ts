import type { LoadableSkill } from '@/plugin'

export const PLAN_REVIEW_SKILL_NAME = 'plan-review'

export const PLAN_REVIEW_SKILL_DESCRIPTION =
  'Review a plan, RFC, design doc, PRFAQ, or task breakdown. Covers problem framing, measurable success criteria, alternatives considered, reversibility (one-way vs two-way doors), risk and dependency analysis, and RFC-2119 requirement-keyword discipline.'

export const PLAN_REVIEW_SKILL_CONTENT = `# plan-review

You have been asked to review a plan — an RFC, a design doc, a PRFAQ, a roadmap, a todo breakdown, or any document that proposes a course of action. Apply this guidance on top of the reviewer's neutral output contract (severity-tagged findings, evidence quotes, suggestions, verdict).

## How to acquire the target

- **A file path** — \`read\` it. \`ls\` the directory for a template or sibling RFCs that establish the expected shape; deviation from an established plan template is itself worth noting.
- **A URL or doc** — \`web_fetch\` it. If it is a private doc the fetch cannot reach, say so in \`<summary>\` and review what the payload provided.
- **A PR that adds a design doc** — use \`gh pr diff <n>\` for a small change. When broad local context is needed, call \`github_prepare_review_checkout\` once for initial acquisition with the repo slug and 40-character head SHA, then use the returned receipt path exactly for batched \`read\`/\`grep\`/\`find\` calls. If and only if a read-only operation against that exact returned receipt path fails with \`ENOENT\` / \`No such file or directory\`, call the checkout tool one additional time with the same exact repo slug and 40-character head SHA, then use only the new returned receipt. This is a maximum two checkout tool calls; never retry generic command, tool, or provider failures or change coordinates. Never guess or reconstruct a path or acquire a checkout with bash. If recovery also fails, stop checkout attempts and fall back to remote reads where feasible or return an honest incomplete review. Read linked context when referenced; a plan is judged partly on whether it answers the question that prompted it.
- **An inline plan in the payload** — read it carefully and quote from it when forming evidence.

## What to look for

1. **Problem framing.** Does the plan state the problem before the solution? Who feels the pain, and what does "solved" look like for them? A plan that opens with the solution and never names the problem cannot be evaluated — that gap is the first finding.
2. **Measurable success criteria.** Goals must be checkable. "Improve performance" is unverifiable; "P95 latency under 200ms on the checkout path" is. Flag every load-bearing goal that has no metric, threshold, or acceptance condition.
3. **Alternatives considered.** A serious proposal names the approaches it rejected and why. A plan that presents one path as if it were the only path has hidden its reasoning — ask for the alternatives, because the rejected ones are where the real trade-off lives.
4. **Reversibility — one-way vs two-way doors.** Identify the decisions that are hard or impossible to undo: public API contracts, on-disk schema changes, data migrations, anything external parties will depend on. A plan that makes a one-way-door decision without acknowledging it as irreversible has under-weighted its own risk. This is frequently the single most important finding.
5. **Risk and dependency analysis.** External dependencies, blocking teams, legal or compliance constraints, the order in which steps must land. A plan whose step 3 silently depends on a team that has not agreed is carrying unpriced risk.
6. **Scope boundaries.** What is explicitly in scope and out of scope? A plan that conflates several unrelated changes, or whose title promises A but whose body spends half its bytes on B, has a scope problem — either the scope is wrong or the framing is.
7. **Requirement-keyword discipline (RFC-2119).** If the plan uses MUST / SHOULD / MAY, are they used in their precise senses, or interchangeably? A "SHOULD" that is actually a "MUST" will be implemented as optional and bite later. Flag normative keywords whose strength does not match their intent.
8. **Rollback / recovery.** For a plan that changes a running system, how is it undone if it fails, and how long does that take? Absence of a rollback story is a finding when the change is risky enough to need one.

## Review every plan as a first review — do not guess its maturity

You are almost never told whether a plan is a first draft, a final RFC, or something between. Do NOT guess, and do NOT let the absence of that signal bias you — neither toward over-blocking (treating a sketch as a contract) nor toward over-softening (treating a serious proposal as throwaway). Review what is actually on the page, every time, as if you are seeing it fresh with no prior history. This neutrality is the point: a plan's verdict should come from the plan, not from an assumption about its stage you had to invent.

In practice:

- **Judge the idea, not the polish.** A plan can be early and still sound, or finished and still wrong. Your findings target whether the *approach* holds up — internal consistency, reversibility, measurable success, acknowledged alternatives — not how complete the document looks.
- **Missing context is missing context, not a defect.** A plan reviewed cold will omit things a real org would supply: who owns it, the deadline, the budget, the constraint that rules out option B. Do NOT raise each absence as its own blocker — that is exactly the generic-review noise the contract forbids. Fold what you would genuinely need into a single \`comment\`-level finding: "To judge this as ready-to-execute I'd need the owning team, a success metric, and the rollback constraint." One finding, not ten.
- **An unfilled section is only a finding if its absence breaks the idea.** A plan with no rollback section is not automatically blocked — unless the plan's viability *depends* on a rollback that may be impossible, in which case the gap is the finding and you say why. Empty-by-stage is not the same as flawed. Test each gap: does this missing piece change whether the approach is sound, or is it just not written yet?
- **Real flaws are still blockers, regardless of stage.** Reviewing cold does not mean reviewing soft. An internal contradiction, a one-way-door decision the plan does not acknowledge as irreversible, a success criterion that is unmeasurable *as written*, or a recommendation with no alternatives considered — these are flaws in the idea itself. Raise them at full severity whether the plan is draft or final.
- **State your footing in \`<summary>\`, once.** Open with one clause naming what you could and could not assess: "Reviewed on its own terms; no constraints or finality were stated, so the verdict reflects the idea as written, not its fit to an unstated bar." This keeps the review honest about the context it lacked instead of pretending to a certainty it does not have — without guessing at a maturity label. Keep this to one clause; it is grounding, not a process narration.

## Severity hints specific to plans

- **blocker** — A load-bearing flaw in the approach: an internal contradiction, a one-way-door decision treated as reversible, a goal that cannot be verified as written, a plan whose central mechanism cannot work. The kind of problem that makes executing the plan a mistake.
- **concern** — A weakness that should be answered before commitment: a missing alternative that undercuts the recommendation, an unpriced dependency, a scope ambiguity that will mislead implementers, a normative keyword whose strength is wrong.
- **nit** — A small clarity or structure issue, a section that could be tightened, a stage-normal gap worth a one-line mention.
- **praise** — A non-obvious risk surfaced and handled, a reversibility analysis done honestly, a success metric that is genuinely measurable. Rare.

## Verdict mapping

- **approve** — The idea holds and the gaps are stage-normal. No load-bearing flaw in the approach.
- **request-changes** — At least one blocker: a flaw in the approach that needs an answer before this should be committed to.
- **comment** — Useful observations that do not resolve to a clean accept/reject. Common when reviewing a plan cold, where your job is to surface what is unverified rather than to gate it.

## Final output

Return findings inside the reviewer's neutral \`<review>\` block. Do NOT invent your own output format.
`

export const PLAN_REVIEW_SKILL: LoadableSkill = {
  name: PLAN_REVIEW_SKILL_NAME,
  description: PLAN_REVIEW_SKILL_DESCRIPTION,
  content: PLAN_REVIEW_SKILL_CONTENT,
}
