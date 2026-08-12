import { describe, expect, test } from 'bun:test'

import { REVIEWER_SKILLS, REVIEWER_SYSTEM_PROMPT, createReviewerSubagent, reviewerPayloadSchema } from './reviewer'
import { CODE_REVIEW_SKILL } from './skills/code-review'
import { DATA_REVIEW_SKILL } from './skills/data-review'
import { DOC_REVIEW_SKILL } from './skills/doc-review'
import { GENERAL_REVIEW_SKILL } from './skills/general'
import { PLAN_REVIEW_SKILL } from './skills/plan-review'
import { SECURITY_AUDIT_SKILL } from './skills/security-audit'
import { WRITING_REVIEW_SKILL } from './skills/writing-review'

describe('reviewer subagent — load-bearing prompt phrases', () => {
  test.each(
    [
      'READ-ONLY',
      'STRICTLY PROHIBITED',
      'parallel',
      '<review>',
      '<summary>',
      '<findings>',
      '<finding',
      '<verdict>',
      'blocker',
      'concern',
      'praise',
      'approve',
      'request-changes',
      'comment',
    ].map((phrase) => [phrase] as const),
  )('prompt contains %s', (phrase) => {
    const haystack = REVIEWER_SYSTEM_PROMPT.toLowerCase()
    expect(haystack).toContain(phrase.toLowerCase())
  })

  test('prompt forbids posting to channels (parent owns posting, reviewer is analysis-only)', () => {
    const lower = REVIEWER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('posting to github')
    expect(lower).toContain('parent owns posting')
  })

  test('prompt forbids bash for write/mutating operations', () => {
    expect(REVIEWER_SYSTEM_PROMPT).toContain('mkdir')
    expect(REVIEWER_SYSTEM_PROMPT).toContain('rm')
    expect(REVIEWER_SYSTEM_PROMPT).toContain('git add')
    expect(REVIEWER_SYSTEM_PROMPT).toContain('git commit')
    expect(REVIEWER_SYSTEM_PROMPT).toContain('git push')
  })

  test('prompt scopes read-only to side effects, not local bytes, so a skill may carve a /tmp scratch exception without contradiction', () => {
    // A loaded skill (code-review) may permit cloning a PR head into /tmp to
    // read it at line accuracy. The base prompt must frame the boundary as
    // "no side effects on the reviewed artifact / remote / persistent
    // workspace" so that carve-out is not a contradiction of the forbidden-verb
    // list — while the list still applies everywhere else.
    const lower = REVIEWER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('no side effects on the reviewed artifact')
    expect(lower).toContain('throwaway scratch directory under `/tmp`')
    expect(lower).toContain('treat the list as absolute')
  })

  test('prompt names the dedicated tools by their exact runtime names', () => {
    expect(REVIEWER_SYSTEM_PROMPT).toContain('`read`')
    expect(REVIEWER_SYSTEM_PROMPT).toContain('`grep`')
    expect(REVIEWER_SYSTEM_PROMPT).toContain('`find`')
    expect(REVIEWER_SYSTEM_PROMPT).toContain('`ls`')
    expect(REVIEWER_SYSTEM_PROMPT).toContain('`bash`')
    expect(REVIEWER_SYSTEM_PROMPT).toContain('`web_search`')
    expect(REVIEWER_SYSTEM_PROMPT).toContain('`web_fetch`')
    expect(REVIEWER_SYSTEM_PROMPT).toContain('`load_skill`')
  })

  test('prompt is domain-neutral: does NOT inline code-review-specific workflow steps in the "how to review" section', () => {
    // Drift guard: the whole point of the skill refactor is that
    // code-specific guidance (correctness checklists, security checklists,
    // PR-fetching commands as workflow steps) lives in the code-review
    // skill, not in the base prompt. If a future edit pulls that back into
    // REVIEWER_SYSTEM_PROMPT, the reviewer becomes useless for plan/design
    // /docs review and this test catches it.
    expect(REVIEWER_SYSTEM_PROMPT).not.toContain('**Code review:**')
    expect(REVIEWER_SYSTEM_PROMPT).not.toContain('**Plan review:**')
    expect(REVIEWER_SYSTEM_PROMPT).not.toContain('**Design review:**')
    expect(REVIEWER_SYSTEM_PROMPT).not.toContain('**Docs review:**')
  })

  test('prompt instructs the reviewer to load a skill BEFORE forming findings (architectural intent)', () => {
    const lower = REVIEWER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('load_skill')
    expect(lower).toContain('identify the target')
    expect(lower).toContain('domain')
    // "The first thing you do for any review is …" is the load-bearing
    // phrase that makes skill-loading the default, not the exception.
    expect(REVIEWER_SYSTEM_PROMPT).toContain('first thing you do')
  })

  test('prompt names the structured output shape explicitly (so the parent can rely on parseable findings)', () => {
    expect(REVIEWER_SYSTEM_PROMPT).toContain('<finding severity=')
    expect(REVIEWER_SYSTEM_PROMPT).toContain('<issue>')
    expect(REVIEWER_SYSTEM_PROMPT).toContain('<evidence>')
    expect(REVIEWER_SYSTEM_PROMPT).toContain('<suggestion>')
  })

  test('prompt frames delegation as context-saving (deep model offloads bulk to cheaper workers)', () => {
    const lower = REVIEWER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('spawn_subagent')
    expect(lower).toContain('cheaper')
    // The judgment stays with the reviewer — delegation gathers, never decides.
    expect(lower).toContain('never delegate the judgment')
  })

  test('prompt actively encourages parallel scout/explorer delegation for faster reviews (not just permits it)', () => {
    // Drift guard: the capability existed but went unused because the prompt
    // framed delegation as a context-saving option, never as the speed default.
    // Names scout/explorer + ties them to a faster, parallel review.
    const lower = REVIEWER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('`scout`')
    expect(lower).toContain('`explorer`')
    expect(lower).toContain('faster')
    expect(lower).toContain('in parallel')
  })

  test('prompt batches independent reads and waits for background completion reminders instead of polling', () => {
    const lower = REVIEWER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('batch independent')
    expect(lower).toContain('completion `<system-reminder>`')
    expect(lower).toContain('do not poll `subagent_output`')
  })

  test('prompt forbids unsupported shell composition and manual review checkouts', () => {
    const lower = REVIEWER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('no shell loops, pipelines, redirects')
    expect(lower).toContain('never guess or reconstruct a `/tmp` path')
    expect(lower).not.toContain('one-shot pipelines')
    expect(lower).not.toContain('git clone`/`fetch`/detached')
  })

  test('prompt still forbids side effects through a delegate (no laundering write access via a subagent)', () => {
    const lower = REVIEWER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('a subagent you spawn cannot do for you')
  })

  test('prompt forbids generic LLM review noise (drift guard: the whole point of a deep-model reviewer)', () => {
    expect(REVIEWER_SYSTEM_PROMPT).toContain('generic LLM review noise')
    expect(REVIEWER_SYSTEM_PROMPT).toContain('cannot point at a line')
  })

  test('prompt tells reviewer to verify external claims with web tools (citations not vibes)', () => {
    const lower = REVIEWER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('verify external claims')
    expect(lower).toContain('cite the source')
  })

  test('prompt frames the role as deep-model analysis (so token-spend is justified)', () => {
    const lower = REVIEWER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('quality, not speed')
    expect(lower).toContain('spend tokens')
  })
})

describe('reviewer subagent declaration', () => {
  test('is registered as visibility=public so spawn_subagent exposes it', () => {
    const sub = createReviewerSubagent()
    expect(sub.visibility).toBe('public')
  })

  test('uses the deep model profile (quality over speed for analysis)', () => {
    const sub = createReviewerSubagent()
    expect(sub.profile).toBe('deep')
  })

  test('does NOT require a specific permission (member with generic subagent.spawn can spawn it)', () => {
    const sub = createReviewerSubagent()
    expect(sub.requiresSpecificPermission ?? false).toBe(false)
  })

  test('declares canSpawnSubagents=true (deep-model reviewer offloads bulk gathering to cheaper workers)', () => {
    const sub = createReviewerSubagent()
    expect(sub.canSpawnSubagents).toBe(true)
  })

  test('declares the readonly-reviewer bash policy so its bash is fenced regardless of the spawning role (issue #452)', () => {
    const sub = createReviewerSubagent()
    expect(sub.bashPolicy).toEqual({ kind: 'readonly-reviewer' })
  })

  test('tools list is read-only by whitelist: read/grep/find/ls/bash/web_search/web_fetch with NO write/edit', () => {
    const sub = createReviewerSubagent()
    const toolNames = (sub.tools ?? []).map((t) => t.__builtinTool).sort()
    expect(toolNames).toEqual(['bash', 'find', 'grep', 'ls', 'read', 'web_fetch', 'web_search'])
    expect(toolNames).not.toContain('write')
    expect(toolNames).not.toContain('edit')
  })

  test('customTools contains exactly one tool: load_skill (the runtime-skill-loader)', () => {
    const sub = createReviewerSubagent()
    expect(sub.customTools).toBeDefined()
    expect(sub.customTools).toHaveLength(1)
    const loadSkill = sub.customTools?.[0]
    if (loadSkill === undefined) throw new Error('load_skill tool missing')
    // The factory builds a description that menus the skills. Verify the
    // names surface so the model can pick from the prompt-visible enum.
    expect(loadSkill.description).toContain('`code-review`')
    expect(loadSkill.description).toContain('`general`')
    expect(loadSkill.description).toContain('`security-audit`')
  })

  test('load_skill parameter schema accepts every shipped skill name and rejects unknown ones', () => {
    const sub = createReviewerSubagent()
    const loadSkill = sub.customTools?.[0]
    if (loadSkill === undefined) throw new Error('load_skill tool missing')
    for (const skill of REVIEWER_SKILLS) {
      expect(loadSkill.parameters.safeParse({ name: skill.name }).success).toBe(true)
    }
    expect(loadSkill.parameters.safeParse({ name: 'not-a-real-skill' }).success).toBe(false)
    expect(loadSkill.parameters.safeParse({ name: '' }).success).toBe(false)
  })

  test('REVIEWER_SKILLS ships the domain-neutral review set with general last as the fallback', () => {
    const names = REVIEWER_SKILLS.map((s) => s.name)
    expect(names).toContain('code-review')
    expect(names).toContain('doc-review')
    expect(names).toContain('plan-review')
    expect(names).toContain('security-audit')
    expect(names).toContain('writing-review')
    expect(names).toContain('data-review')
    expect(names).toContain('general')
    expect(names.at(-1)).toBe('general')
  })

  test('REVIEWER_SKILLS has no duplicate names (load_skill enum stays unambiguous)', () => {
    const names = REVIEWER_SKILLS.map((s) => s.name)
    expect(new Set(names).size).toBe(names.length)
  })

  test('declares a tool-result budget so a runaway subagent cannot exhaust parent context', () => {
    const sub = createReviewerSubagent()
    expect(sub.toolResultBudget).toBeDefined()
    expect(sub.toolResultBudget?.maxTotalBytes).toBeGreaterThan(0)
  })

  test('tool-result budget covers load_skill so loaded skill bodies count against the same cap', () => {
    const sub = createReviewerSubagent()
    expect(sub.toolResultBudget?.toolNames).toContain('load_skill')
  })

  test('budget sits between explorer (256KB) and operator (1MB) — read-only deep analysis, larger than explorer but bounded', () => {
    const sub = createReviewerSubagent()
    const budget = sub.toolResultBudget?.maxTotalBytes ?? 0
    expect(budget).toBeGreaterThan(256_000)
    expect(budget).toBeLessThan(1_000_000)
  })

  test('declares a spawn timeout so a stalled review fails the parent loudly instead of hanging forever', () => {
    const sub = createReviewerSubagent()
    expect(sub.timeoutMs).toBeGreaterThan(0)
  })

  test('spawn timeout is generous enough for a deep-model review of a large PR but not unbounded', () => {
    const sub = createReviewerSubagent()
    const timeout = sub.timeoutMs ?? 0
    expect(timeout).toBeGreaterThanOrEqual(1_800_000)
    expect(timeout).toBeLessThanOrEqual(1_800_000)
  })

  test('inFlightKey returns distinct values for distinct requestId payloads (parallel spawns must not coalesce)', () => {
    const sub = createReviewerSubagent()
    const k1 = sub.inFlightKey?.({ requestId: 'bg_a' })
    const k2 = sub.inFlightKey?.({ requestId: 'bg_b' })
    expect(k1).toBe('bg_a')
    expect(k2).toBe('bg_b')
    expect(k1).not.toBe(k2)
  })

  test('inFlightKey falls back to a random value when no requestId is provided (no accidental coalescing)', () => {
    const sub = createReviewerSubagent()
    const k1 = sub.inFlightKey?.({})
    const k2 = sub.inFlightKey?.({})
    expect(k1).not.toBe(k2)
  })
})

describe('reviewer skill content', () => {
  test('CODE_REVIEW_SKILL has the expected name/description/non-empty content', () => {
    expect(CODE_REVIEW_SKILL.name).toBe('code-review')
    expect(CODE_REVIEW_SKILL.description.length).toBeGreaterThan(0)
    expect(CODE_REVIEW_SKILL.content.length).toBeGreaterThan(0)
  })

  test('GENERAL_REVIEW_SKILL has the expected name/description/non-empty content', () => {
    expect(GENERAL_REVIEW_SKILL.name).toBe('general')
    expect(GENERAL_REVIEW_SKILL.description.length).toBeGreaterThan(0)
    expect(GENERAL_REVIEW_SKILL.content.length).toBeGreaterThan(0)
  })

  test('code-review skill body teaches code-specific craft (drift guard against neutralization)', () => {
    const lower = CODE_REVIEW_SKILL.content.toLowerCase()
    expect(lower).toContain('correctness')
    expect(lower).toContain('security')
    expect(lower).toContain('test coverage')
    expect(lower).toContain('gh pr diff')
  })

  test('code-review skill suppresses false positives the author already owns (drift guard)', () => {
    // Without these, the reviewer restates the PR body and re-raises self-flagged TODOs as noise.
    const lower = CODE_REVIEW_SKILL.content.toLowerCase()
    expect(lower).toContain('restating the change description')
    expect(lower).toContain('already-acknowledged gaps')
  })

  test('code-review skill reviews the PR title/body as a first-class artifact, not just context (drift guard)', () => {
    // The core behavior of this skill's PR-record dimension: the title/body is a
    // review target in its own right (a record of the why), and the reviewer must
    // catch a diff change whose rationale is silently dropped. Without these, the
    // section can be neutralized back to "body is only input to verify code against".
    const lower = CODE_REVIEW_SKILL.content.toLowerCase()
    expect(lower).toContain('review the pr title and body as an artifact')
    expect(lower).toContain('a pr is a record')
    expect(lower).toContain('rationale for every meaningful change')
    expect(lower).toContain('meaning-unit separation')
  })

  test('code-review skill reconciles restating-vs-reviewing the description as echo-vs-evaluate (drift guard)', () => {
    // The load-bearing reconciliation: the new PR-body review must not collide with
    // the pre-existing "restating the change description = noise" rule. The distinction
    // is echo (noise) vs. evaluate (in scope). Without this the two sections read as a
    // direct contradiction and the new dimension gets suppressed as restatement.
    const lower = CODE_REVIEW_SKILL.content.toLowerCase()
    expect(lower).toContain('echo vs. evaluate')
    expect(lower).toContain('do not confuse restating the description with reviewing it')
  })

  test('code-review skill demands blast-radius + pinned evidence on findings (drift guard)', () => {
    // A line anchor says where; these say how far it reaches and where the evidence lives.
    const lower = CODE_REVIEW_SKILL.content.toLowerCase()
    expect(lower).toContain('blast radius')
    expect(lower).toContain('pin the evidence')
  })

  test('code-review skill checks intent drift, not just local architecture fit (drift guard)', () => {
    // A diff can compile, pass its own tests, and still pull the system away
    // from the design intent the surrounding code was built on. Without naming
    // intent drift, the reviewer only catches layering/duplication and misses
    // the "purely a refactor that quietly changed behavior" class.
    const lower = CODE_REVIEW_SKILL.content.toLowerCase()
    expect(lower).toContain('intent drift')
    expect(lower).toContain('diverges from the design intent')
  })

  test('code-review skill hunts regressions in callers the diff never shows (drift guard)', () => {
    // The regression's other half lives in an existing caller of a changed
    // contract — not in the diff, not in this PR's test count. Without this the
    // reviewer clears a contract change as "looks fine in the diff" and the
    // broken caller ships silently.
    const lower = CODE_REVIEW_SKILL.content.toLowerCase()
    expect(lower).toContain('regression risk and blast radius')
    expect(lower).toContain('who depended on the old behavior')
  })

  test('code-review skill traces side effects that reach outside the changed lines (drift guard)', () => {
    // The dangerous side effect (mutated shared state, un-invalidated cache,
    // leaked resource on a new error path) has no line in the diff to anchor
    // to — it emerges from interaction. Without this the reviewer only sees
    // what changed, never what the change disturbs.
    const lower = CODE_REVIEW_SKILL.content.toLowerCase()
    expect(lower).toContain('side effects and ripple')
    expect(lower).toContain('cleanup path')
  })

  test('code-review skill flags change hygiene — stray temporary commits (drift guard)', () => {
    // Escaped scaffolding (wip/fixup commits, debug logging) the language-neutral base prompt misses.
    const lower = CODE_REVIEW_SKILL.content.toLowerCase()
    expect(lower).toContain('change hygiene')
    expect(lower).toContain('fixup!')
  })

  test('code-review skill forces a re-decide verdict on re-reviews (regression guard for stuck CHANGES_REQUESTED)', () => {
    // A re-review must end in approve/request-changes; a `comment` verdict
    // leaves the PR's blocking state stuck because a plain comment does not
    // clear CHANGES_REQUESTED on GitHub. Without this, fix-and-re-request
    // cycles silently leave the bot blocking the PR forever.
    const lower = CODE_REVIEW_SKILL.content.toLowerCase()
    expect(lower).toContain('re-review')
    expect(lower).toContain('do not return `comment` on a re-review')
  })

  test('code-review skill recognizes a conversationally-phrased address as a re-review trigger (no explicit "review again" required)', () => {
    // An author responding to a blocker — "fixed", "addressed your review",
    // "pushed a fix" — is a re-review even without the words "review again".
    // Without this, a fix-and-address cycle phrased as chat falls through to a
    // `comment` verdict and the bot's prior block stays stranded.
    const lower = CODE_REVIEW_SKILL.content.toLowerCase()
    expect(lower).toContain('addressed your prior blocking feedback')
    expect(lower).toContain('review again')
  })

  test('code-review skill stops the reviewer retrying local /agent reads and routes to head-SHA remote-read (ENOENT rule)', () => {
    // The reviewer's cwd is the agent folder, not the PR's repo. Without the
    // ENOENT rule it re-issues `read /agent/...` that can never resolve, then
    // limps to gh-api with ad-hoc base64/line-number gymnastics. The skill must
    // name the signal (ENOENT) and the canonical head-SHA recipe.
    const content = CODE_REVIEW_SKILL.content
    const lower = content.toLowerCase()
    expect(lower).toContain('enoent')
    expect(lower).toContain('stop retrying local reads')
    expect(lower).toContain('head sha')
    // The recipe MUST be a single bare `gh api` at the head SHA with the raw
    // media type — NOT a pipe. A repo-targeting `gh` piped into `base64`/`nl`
    // is rejected by the token-leak guard (a sibling stage would inherit the
    // minted App token), so the skill must steer away from that shape.
    expect(content).toContain('gh api')
    expect(content).toContain('?ref=<headSha>')
    expect(content).toContain('application/vnd.github.raw')
    expect(lower).toContain('single bare `gh` invocation')
    expect(lower).toContain('do not pipe')
  })

  test('code-review skill uses the runtime-owned exact-SHA checkout for broad navigation', () => {
    const content = CODE_REVIEW_SKILL.content
    const lower = content.toLowerCase()
    expect(lower).toContain('scratch checkout')
    expect(content).toContain('github_prepare_review_checkout')
    expect(content).toContain('<40-char headSha>')
    expect(lower).toContain('do not use `git clone`')
    expect(lower).toContain('never the reviewed artifact')
    expect(lower).toContain('leave cleanup to the session lifecycle')
    expect(lower).toContain('only kind of write')
    expect(lower).toContain('once for initial acquisition')
    expect(lower).toContain('use the returned receipt path exactly')
    expect(lower).toContain('never guess, derive, or reconstruct')
  })

  test('code-review skill reuses prior review work and narrows re-review exploration to intervening changes', () => {
    const lower = CODE_REVIEW_SKILL.content.toLowerCase()
    expect(lower).toContain('compare the prior reviewed head with the current head')
    expect(lower).toContain('intervening changes')
    expect(lower).toContain('reuse prior findings')
    expect(lower).toContain('cumulative correctness')
  })

  test.each([
    ['code-review', CODE_REVIEW_SKILL.content],
    ['doc-review', DOC_REVIEW_SKILL.content],
    ['plan-review', PLAN_REVIEW_SKILL.content],
  ])('%s permits one tightly bounded recovery when its runtime checkout receipt vanishes', (_name, content) => {
    const lower = content.toLowerCase()
    expect(content).toContain('github_prepare_review_checkout')
    expect(lower).toContain('once for initial acquisition')
    expect(lower).toContain('returned receipt path exactly')
    expect(lower).toContain('never guess')
    expect(lower).toContain('if and only if')
    expect(lower).toContain('read-only operation against that exact returned receipt path')
    expect(lower).toContain('enoent')
    expect(lower).toContain('no such file or directory')
    expect(lower).toContain('one additional time')
    expect(lower).toContain('same exact repo slug and 40-character head sha')
    expect(lower).toContain('use only the new returned receipt')
    expect(lower).toContain('maximum two checkout tool calls')
    expect(lower).toContain('generic command, tool, or provider failures')
    expect(lower).toContain('stop checkout attempts')
    expect(lower).toContain('remote reads')
    expect(lower).toContain('honest incomplete review')
  })

  test('code-review skill accounts for resolved threads in the summary, not as praise findings (re-review noise guard)', () => {
    // In re-reviews the model is tempted to emit one `praise` finding per
    // fixed thread ("Thread 123 is addressed"), diluting the rare-praise
    // signal and producing inline comments the parent strips anyway. The skill
    // must route resolution accounting to the <summary> and reserve findings
    // for what still needs action.
    const lower = CODE_REVIEW_SKILL.content.toLowerCase()
    expect(lower).toContain('account for resolved threads in the')
    expect(lower).toContain('not as `praise` findings')
    expect(lower).toContain('one `praise` finding per prior concern the author fixed')
  })

  test('code-review skill guards against reviewer-imposed scope drift while keeping correctness in scope (drift guard)', () => {
    // The reviewer's own findings can pull a PR away from the author's stated
    // intent — "I would build it differently" turned into a requirement. Without
    // this the review gold-plates the author's approach across pushes. But the
    // guard must NOT excuse real defects: intent bounds what you may demand, it
    // does not redefine correctness, and an evidence-backed deviation from the
    // codebase's OWN established architecture/conventions stays a legitimate
    // finding. The cumulative re-review check must also account for the fresh
    // reviewer having no memory of its prior rounds.
    const lower = CODE_REVIEW_SKILL.content.toLowerCase()
    expect(lower).toContain('reviewer-imposed scope drift')
    expect(lower).toContain("author's intent baseline")
    // intent bounds what you may DEMAND, but does not redefine correctness —
    // a bug inside the chosen scope is always fair game.
    expect(lower).toContain('it does not redefine **correctness**'.toLowerCase())
    // the architecture-fit exception is not suppressed: a codebase-own
    // deviation that "will compound" remains findable before other defects.
    expect(lower).toContain('will compound')
    // cumulative re-review re-anchoring, aware the reviewer has no memory of
    // its own prior feedback and must reconstruct or fall back to the baseline.
    expect(lower).toContain('cumulative direction')
    expect(lower).toContain('no memory of your own prior rounds')
    expect(lower).toContain('current cumulative diff')
    // The prescribed history reads MUST paginate: GitHub returns reviews/comments
    // 30 per page, so an unpaginated read truncates the very history the
    // cumulative check needs on a long-lived PR (same reason the channel-github
    // re-review query paginates). Without this the check silently misattributes.
    expect(lower).toContain('`--paginate` is mandatory here')
  })

  test('general skill body teaches universal review craft (load-bearing audience-fit phrasing)', () => {
    const lower = GENERAL_REVIEW_SKILL.content.toLowerCase()
    expect(lower).toContain('load-bearing')
    expect(lower).toContain('hidden assumptions')
  })

  test('doc-review leads with universal craft and does not prime a document-type taxonomy (anti-bias guard)', () => {
    // Enumerating kinds (README/policy/onboarding/...) in the description or
    // opening biases the reviewer toward the named kinds and against the
    // unnamed ones — the same enumeration bias plan-review forbids. The skill
    // must route by function ("a document written to inform or instruct") and
    // tell the reviewer not to assume a kind, then carry it with universal
    // craft.
    expect(DOC_REVIEW_SKILL.name).toBe('doc-review')
    expect(DOC_REVIEW_SKILL.description).toContain('inform or instruct')
    const lower = DOC_REVIEW_SKILL.content.toLowerCase()
    expect(lower).toContain('do not assume a kind')
    expect(lower).toContain('audience fit')
    expect(lower).toContain('examples and claims')
    expect(lower).toContain('prerequisite')
  })

  test('doc-review keeps the technical-doc specialization as a scoped sub-case (Diátaxis + runnable samples)', () => {
    const lower = DOC_REVIEW_SKILL.content.toLowerCase()
    expect(lower).toContain('diátaxis')
    expect(lower).toContain('when the target is technical documentation')
    expect(lower).toContain('do not force a policy')
  })

  test('plan-review skill teaches reversibility and measurable success (drift guard)', () => {
    expect(PLAN_REVIEW_SKILL.name).toBe('plan-review')
    expect(PLAN_REVIEW_SKILL.description.length).toBeGreaterThan(0)
    const lower = PLAN_REVIEW_SKILL.content.toLowerCase()
    expect(lower).toContain('one-way')
    expect(lower).toContain('success criteria')
    expect(lower).toContain('alternatives considered')
  })

  test('plan-review skill enforces bias-free maturity-neutral review (the load-bearing first-review rule)', () => {
    // Without this, the reviewer guesses whether a plan is draft-vs-final and
    // either blocker-spams a sketch or rubber-stamps a flawed proposal. The
    // rule is to review the idea as written and fold missing context into ONE
    // finding, not N blockers.
    const lower = PLAN_REVIEW_SKILL.content.toLowerCase()
    expect(lower).toContain('do not guess its maturity')
    expect(lower).toContain('missing context is missing context, not a defect')
  })

  test('security-audit skill teaches the input-to-sink threat lens with OWASP/CWE anchors (drift guard)', () => {
    expect(SECURITY_AUDIT_SKILL.name).toBe('security-audit')
    expect(SECURITY_AUDIT_SKILL.description.length).toBeGreaterThan(0)
    const lower = SECURITY_AUDIT_SKILL.content.toLowerCase()
    expect(lower).toContain('injection')
    expect(lower).toContain('ssrf')
    expect(lower).toContain('owasp')
    expect(lower).toContain('exploitab')
  })

  test('writing-review skill teaches editorial craft beyond grammar (drift guard)', () => {
    expect(WRITING_REVIEW_SKILL.name).toBe('writing-review')
    expect(WRITING_REVIEW_SKILL.description.length).toBeGreaterThan(0)
    const lower = WRITING_REVIEW_SKILL.content.toLowerCase()
    expect(lower).toContain('lede')
    expect(lower).toContain('audience')
    expect(lower).toContain('unsupported claim')
  })

  test('data-review skill covers both the shape (schema/migration) and the data itself (drift guard)', () => {
    expect(DATA_REVIEW_SKILL.name).toBe('data-review')
    expect(DATA_REVIEW_SKILL.description.length).toBeGreaterThan(0)
    const lower = DATA_REVIEW_SKILL.content.toLowerCase()
    expect(lower).toContain('migration')
    expect(lower).toContain('referential integrity')
    expect(lower).toContain('schema-invalid')
    expect(lower).toContain('not null')
  })

  test('every shipped skill references the reviewer neutral output contract (so domain skills compose with the universal shape)', () => {
    for (const skill of REVIEWER_SKILLS) {
      expect(skill.content).toContain('<review>')
    }
  })

  test('every shipped skill closes by deferring to the neutral output block (no domain skill invents its own format)', () => {
    for (const skill of REVIEWER_SKILLS) {
      expect(skill.content).toContain('Do NOT invent your own output format')
    }
  })
})

describe('reviewerPayloadSchema', () => {
  test('accepts a full payload with requestId + prompt + description', () => {
    const result = reviewerPayloadSchema.safeParse({
      requestId: 'bg_t1',
      prompt: 'review PR #42 for security issues',
      description: 'PR review',
    })
    expect(result.success).toBe(true)
  })

  test('accepts a payload with only requestId (spawn-tool minimum)', () => {
    const result = reviewerPayloadSchema.safeParse({ requestId: 'bg_t1' })
    expect(result.success).toBe(true)
  })

  test('passes through unknown fields (forward-compat with future spawn-tool params, matches explorer/scout/operator)', () => {
    const result = reviewerPayloadSchema.safeParse({ requestId: 'bg_t1', futureField: 42 })
    expect(result.success).toBe(true)
  })
})
