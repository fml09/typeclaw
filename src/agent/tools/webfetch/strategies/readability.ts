import type { Readability as ReadabilityClass } from '@mozilla/readability'
import type TurndownService from 'turndown'

import { walkHtmlLexically } from '../html-lexical'
import { classifyRawInlineStyleVisibility, VISIBILITY_PROPERTIES } from '../inline-style-visibility'

// Perf: jsdom (+readability+turndown) costs ~40-60MB RSS at import time. Keep it
// lazy so idle agents that never call web_fetch don't pay for it. Do NOT hoist to
// a top-level import.
type ReadabilityDeps = {
  Readability: typeof ReadabilityClass
  JSDOM: typeof import('jsdom').JSDOM
  turndown: TurndownService
}

let depsPromise: Promise<ReadabilityDeps> | undefined

const MAX_EMBEDDED_STYLE_CHARS = 256 * 1024
const MAX_EMBEDDED_STYLE_RULES = 1_024
const MAX_COMPUTED_STYLE_WORK = 2_000_000
const MAX_SELECTOR_CHARS = 2_048
const MAX_RAW_CSS_SEGMENT_CHARS = 16 * 1024

async function loadDeps(): Promise<ReadabilityDeps> {
  depsPromise ??= (async () => {
    const [{ Readability }, { JSDOM }, { default: TurndownCtor }] = await Promise.all([
      import('@mozilla/readability'),
      import('jsdom'),
      import('turndown'),
    ])
    const turndown = new TurndownCtor({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
      emDelimiter: '*',
      hr: '---',
    })
    turndown.remove(['script', 'style', 'meta', 'link', 'noscript', 'iframe'])
    return { Readability, JSDOM, turndown }
  })()
  return depsPromise
}

type ReadabilityDocument = ConstructorParameters<typeof ReadabilityClass>[0]

export type ReadabilityDetailedResult = {
  output: string
  parsedArticle: boolean
  usedBodyFallback: boolean
  hasSemanticContentContainer: boolean
  hasArticleContainer: boolean
  proseElementCount: number
  structuredContentElementCount: number
  scriptCount: number
  visibleTextCharacterCount: number
}

export async function applyReadability(html: string, url: string): Promise<string> {
  return (await applyReadabilityDetailed(html, url)).output
}

export async function applyReadabilityDetailed(html: string, url: string): Promise<ReadabilityDetailedResult> {
  preflightEmbeddedStylesheets(html)
  const { Readability, JSDOM, turndown } = await loadDeps()
  const dom = new JSDOM(html, { url })
  const sourceDocument = dom.window.document
  const computedStyle = buildComputedStyleResolver(sourceDocument, (element) => dom.window.getComputedStyle(element))
  pruneHiddenContent(sourceDocument, computedStyle)
  const document = sourceDocument.cloneNode(true) as Document & ReadabilityDocument
  const scriptCount = document.querySelectorAll('script').length
  document.querySelectorAll('script, style, template, noscript, noframes').forEach((element) => element.remove())

  const hasSemanticContentContainer = document.querySelector('article, main, [role="main"]') !== null
  const hasArticleContainer = document.querySelector('article') !== null
  const proseElementCount = document.querySelectorAll('p, blockquote, pre').length
  const structuredContentElementCount = document.querySelectorAll('h1, h2, h3, h4, h5, h6, dl, table').length
  const visibleTextCharacterCount = countVisibleTextCharacters(document.body)
  const fallbackSource = document.body?.innerHTML ?? ''
  const article = new Readability(document).parse()

  const source = article?.content?.trim() ? article.content : fallbackSource
  const markdown = turndown.turndown(source).trim()
  const output = renderOutput(markdown, article?.title)

  return {
    output,
    parsedArticle: article?.content?.trim() !== undefined && article.content.trim().length > 0,
    usedBodyFallback: !article?.content?.trim(),
    hasSemanticContentContainer,
    hasArticleContainer,
    proseElementCount,
    structuredContentElementCount,
    scriptCount,
    visibleTextCharacterCount,
  }
}

function preflightEmbeddedStylesheets(html: string): void {
  const sources: string[] = []
  let elementCount = 0
  let styleStartCount = 0
  const result = walkHtmlLexically(html, {
    onStartTag: ({ name }) => {
      elementCount++
      if (name === 'style') styleStartCount++
    },
    onRawElement: (element) => {
      if (element.name === 'style') sources.push(html.slice(element.bodyStart, element.bodyEnd))
    },
  })
  if (!result.valid || styleStartCount === 0) return
  if (sources.length !== styleStartCount) throw new Error('Embedded stylesheet complexity limit exceeded')

  let characters = 0
  let rules = 0
  let selectorComponents = 0
  for (const source of sources) {
    characters += source.length
    if (characters > MAX_EMBEDDED_STYLE_CHARS) throw new Error('Embedded stylesheet complexity limit exceeded')
    const counted = countRawCssRules(source)
    rules += counted.rules
    selectorComponents += counted.selectorComponents
    if (rules > MAX_EMBEDDED_STYLE_RULES) throw new Error('Embedded stylesheet complexity limit exceeded')
  }
  if (selectorComponents * elementCount > MAX_COMPUTED_STYLE_WORK) {
    throw new Error('Embedded stylesheet complexity limit exceeded')
  }
}

function countRawCssRules(source: string): { rules: number; selectorComponents: number } {
  let rules = 0
  let selectorComponents = 0
  let preludeLength = 0
  let preludeStart = 0
  let quote: '"' | "'" | null = null
  let cursor = 0
  while (cursor < source.length) {
    const char = source[cursor]!
    if (char === '\\') {
      if (cursor + 1 >= source.length) throw new Error('Embedded stylesheet complexity limit exceeded')
      cursor += 2
      preludeLength += 2
      continue
    }
    if (quote !== null) {
      if (char === quote) quote = null
      cursor++
      continue
    }
    if (source.startsWith('/*', cursor)) {
      const end = source.indexOf('*/', cursor + 2)
      if (end < 0) throw new Error('Embedded stylesheet complexity limit exceeded')
      cursor = end + 2
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      cursor++
      continue
    }
    if (char === '{') {
      rules++
      if (preludeLength > MAX_RAW_CSS_SEGMENT_CHARS || rules > MAX_EMBEDDED_STYLE_RULES) {
        throw new Error('Embedded stylesheet complexity limit exceeded')
      }
      selectorComponents += countSelectorListComponents(source.slice(preludeStart, cursor), MAX_RAW_CSS_SEGMENT_CHARS)
      preludeLength = 0
      preludeStart = cursor + 1
    } else if (char === '}' || char === ';') {
      preludeLength = 0
      preludeStart = cursor + 1
    } else {
      preludeLength++
      if (preludeLength > MAX_RAW_CSS_SEGMENT_CHARS) throw new Error('Embedded stylesheet complexity limit exceeded')
    }
    cursor++
  }
  if (quote !== null) throw new Error('Embedded stylesheet complexity limit exceeded')
  countSelectorListComponents(source.slice(preludeStart), MAX_RAW_CSS_SEGMENT_CHARS)
  return { rules, selectorComponents }
}

export function buildComputedStyleResolver(
  document: Document,
  resolve: (element: Element) => CSSStyleDeclaration,
): ((element: Element) => CSSStyleDeclaration) | undefined {
  const styles = Array.from(document.querySelectorAll('style'))
  if (styles.length === 0) return undefined

  let styleCharacters = 0
  let ruleCount = 0
  let selectorComponentCount = 0
  for (const style of styles) {
    styleCharacters += style.textContent?.length ?? 0
    if (styleCharacters > MAX_EMBEDDED_STYLE_CHARS) throw new Error('Embedded stylesheet complexity limit exceeded')
    const counted =
      style.sheet === null
        ? { rules: MAX_EMBEDDED_STYLE_RULES + 1, selectorComponents: MAX_EMBEDDED_STYLE_RULES + 1 }
        : countCssRules(style.sheet.cssRules)
    ruleCount += counted.rules
    selectorComponentCount += counted.selectorComponents
    if (ruleCount > MAX_EMBEDDED_STYLE_RULES) throw new Error('Embedded stylesheet complexity limit exceeded')
  }

  const elementCount = document.querySelectorAll('*').length
  if (selectorComponentCount * elementCount > MAX_COMPUTED_STYLE_WORK) {
    throw new Error('Embedded stylesheet complexity limit exceeded')
  }
  reduceToVisibilityDeclarations(styles)
  return (element) => {
    reduceInlineStyleToVisibilityDeclarations(element)
    return resolve(element)
  }
}

// getComputedStyle resolves the WHOLE declaration, but pruneHiddenContent reads
// only VISIBILITY_PROPERTIES. Everything else is computed at our expense and at
// our risk, so it is deleted from the CSSOM before the first resolve.
//
// Load-bearing, not a micro-optimization: this is the fix for an OOM that killed
// a live agent. jsdom 29.0.2 allocates ~27GB and burns ~11s inside a SINGLE
// getComputedStyle() call while reconciling a `border` shorthand against a
// `border-bottom` longhand (living/css/helpers/shorthand-properties.js), then
// throws a TypeError. The triggering CSS is ubiquitous rather than hostile: a
// reset (`span { border: 0 }`) plus a component rule that omits the border
// colour (`.x { border-bottom: 1px solid }`), as every Emotion/MUI page emits.
// A 236KB page with 545 elements was enough to exhaust a 16GB host.
//
// Nothing upstream can catch it. The allocation is SYNCHRONOUS, so the request
// AbortSignal and the 30s timeout never get a turn, and the try/catch in
// isHiddenElement catches the TypeError only after the memory is committed. The
// complexity budgets above bound the QUANTITY of CSS work, so a single
// pathological declaration on a small page passes all of them.
//
// Deleting declarations rather than hand-rolling a cascade keeps jsdom
// authoritative for specificity, inheritance, and !important on the properties
// actually read, so pruning behaviour is unchanged. It also generalises: a
// future jsdom blowup in any property never read here is now unreachable.
// Only the CSSOM is edited — <style> textContent is untouched, so the budgets
// above still measure the original stylesheet.
export function reduceToVisibilityDeclarations(styles: HTMLStyleElement[]): void {
  let budget = MAX_EMBEDDED_STYLE_RULES
  const visit = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      if (budget-- <= 0) return
      if ('cssRules' in rule) visit((rule as CSSGroupingRule).cssRules)
      const { style } = rule as CSSStyleRule
      if (!style) continue
      removeUnreadDeclarations(style)
    }
  }
  for (const style of styles) {
    if (style.sheet !== null) visit(style.sheet.cssRules)
  }
}

function countCssRules(rules: CSSRuleList): { rules: number; selectorComponents: number } {
  let count = 0
  let selectorComponents = 0
  const pending = Array.from(rules)
  while (pending.length > 0) {
    const rule = pending.pop()!
    count++
    if (count > MAX_EMBEDDED_STYLE_RULES) return { rules: count, selectorComponents }
    const prelude =
      'selectorText' in rule ? (rule as CSSStyleRule).selectorText : rule.cssText.slice(0, rule.cssText.indexOf('{'))
    selectorComponents += countSelectorListComponents(prelude, MAX_SELECTOR_CHARS)
    if ('cssRules' in rule) pending.push(...Array.from((rule as CSSGroupingRule).cssRules))
  }
  return { rules: count, selectorComponents }
}

function countSelectorListComponents(source: string, maxLength: number): number {
  if (source.length > maxLength) throw new Error('Embedded stylesheet complexity limit exceeded')
  let components = 1
  let quote: '"' | "'" | null = null
  let parentheses = 0
  let brackets = 0
  let cursor = 0
  while (cursor < source.length) {
    const char = source[cursor]!
    if (char === '\\') {
      if (cursor + 1 >= source.length) throw new Error('Embedded stylesheet complexity limit exceeded')
      cursor += 2
      continue
    }
    if (quote !== null) {
      if (char === quote) quote = null
      cursor++
      continue
    }
    if (source.startsWith('/*', cursor)) {
      const end = source.indexOf('*/', cursor + 2)
      if (end < 0) throw new Error('Embedded stylesheet complexity limit exceeded')
      cursor = end + 2
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '(') parentheses++
    else if (char === ')') {
      if (parentheses === 0) throw new Error('Embedded stylesheet complexity limit exceeded')
      parentheses--
    } else if (char === '[') brackets++
    else if (char === ']') {
      if (brackets === 0) throw new Error('Embedded stylesheet complexity limit exceeded')
      brackets--
    } else if (char === ',' && parentheses === 0 && brackets === 0) components++
    cursor++
  }
  if (quote !== null || parentheses !== 0 || brackets !== 0) {
    throw new Error('Embedded stylesheet complexity limit exceeded')
  }
  return components
}

function countVisibleTextCharacters(body: HTMLElement | null): number {
  if (body === null) return 0
  return Array.from(normalizeVisibleText(body.textContent ?? '')).length
}

export function pruneHiddenContent(
  document: Document,
  computedStyle: ((element: Element) => CSSStyleDeclaration) | undefined,
): void {
  for (const details of document.querySelectorAll('details:not([open])')) pruneClosedDetails(details)

  const elements = Array.from(document.querySelectorAll('*'))
  // Three passes, because reducing an element's inline style has to happen
  // after the checks that read the declarations it removes, but before ANY
  // element resolves a computed style.
  //
  // A single interleaved pass cannot satisfy both. querySelectorAll returns a
  // STATIC list, so a descendant is still visited after its ancestor is
  // removed, and jsdom resolves inherited properties by walking parentElement
  // into that removed ancestor. An ancestor pruned by `hidden`, aria-hidden or
  // the offscreen test returns before the resolver ever touches it, so it would
  // still be carrying its full inline declaration when the descendant reaches
  // it — the OOM route again, one level up.
  const staticallyHidden = new Set<Element>()
  for (const element of elements) {
    if (isStaticallyHiddenElement(element)) staticallyHidden.add(element)
  }
  for (const element of elements) reduceInlineStyleToVisibilityDeclarations(element)
  for (const element of elements) {
    if (staticallyHidden.has(element) || isComputedHiddenElement(element, computedStyle)) element.remove()
  }
}

// The inline style attribute is the second way a declaration reaches the
// cascade, so reducing stylesheets alone leaves the same OOM reachable via
// style="border:0;border-bottom:1px solid". See reduceToVisibilityDeclarations
// for the mechanism.
//
// This runs inside the resolver rather than at a call site so the invariant
// holds for every caller: an element cannot reach getComputedStyle carrying a
// declaration outside VISIBILITY_PROPERTIES. It is safe to reduce this late
// because the callers that need the removed declarations read them WITHOUT the
// resolver — classifyRawInlineStyleVisibility parses the raw attribute text and
// the offscreen test reads position/left/top off element.style, both before
// isHiddenElement resolves anything.
function reduceInlineStyleToVisibilityDeclarations(element: Element): void {
  if (!('style' in element)) return
  removeUnreadDeclarations((element as HTMLElement).style)
}

// Custom properties are retained even though they are not read directly: a
// retained declaration can be written `opacity: var(--hidden)`, and dropping
// the `--hidden` definition would silently un-hide content this guard exists to
// prune. They are safe to keep because a custom property is stored as an
// unparsed token sequence — it never enters the shorthand expansion that makes
// ordinary properties dangerous.
function removeUnreadDeclarations(style: CSSStyleDeclaration): void {
  for (const property of Array.from(style)) {
    if (property.startsWith('--')) continue
    if (!VISIBILITY_PROPERTIES.has(property.toLocaleLowerCase())) style.removeProperty(property)
  }
}

function pruneClosedDetails(details: Element): void {
  const summary = Array.from(details.children).find((child) => child.tagName === 'SUMMARY')
  for (const child of Array.from(details.childNodes)) {
    if (child !== summary) child.remove()
  }
}

// Everything decidable from attributes and the element's own inline style, so
// it stays readable before reduceInlineStyleToVisibilityDeclarations strips the
// declarations these checks consume.
function isStaticallyHiddenElement(element: Element): boolean {
  if (element.hasAttribute('hidden')) return true
  if (element.getAttribute('aria-hidden')?.toLocaleLowerCase() === 'true') return true
  if (element.tagName === 'INPUT' && element.getAttribute('type')?.toLocaleLowerCase() === 'hidden') return true
  if (element.tagName === 'DIALOG' && !element.hasAttribute('open')) return true

  const rawStyle = element.getAttribute('style')
  if (rawStyle !== null && classifyRawInlineStyleVisibility(rawStyle) !== 'visible') return true

  if ('style' in element) {
    const { position, left, top } = (element as HTMLElement).style
    if ((position === 'absolute' || position === 'fixed') && (isFarOffscreen(left) || isFarOffscreen(top))) return true
  }

  return false
}

function isComputedHiddenElement(
  element: Element,
  computedStyle: ((element: Element) => CSSStyleDeclaration) | undefined,
): boolean {
  if (computedStyle === undefined || NON_CONTENT_ELEMENTS.has(element.tagName)) return false
  let resolved: CSSStyleDeclaration
  try {
    resolved = computedStyle(element)
  } catch {
    return false
  }
  if (resolved.display === 'none' || resolved.visibility === 'hidden' || resolved.visibility === 'collapse') return true
  if (resolved.getPropertyValue('content-visibility').trim().toLocaleLowerCase() === 'hidden') return true
  const opacity = Number(resolved.opacity)
  if (resolved.opacity !== '' && Number.isFinite(opacity) && opacity <= 0) return true

  return false
}

const NON_CONTENT_ELEMENTS = new Set([
  'HEAD',
  'LINK',
  'META',
  'NOFRAMES',
  'NOSCRIPT',
  'SCRIPT',
  'STYLE',
  'TEMPLATE',
  'TITLE',
])

function isFarOffscreen(value: string): boolean {
  const match = /^(-?(?:\d+\.?\d*|\.\d+))(px|rem|em|vw|vh)$/iu.exec(value.trim())
  return match !== null && Number(match[1]) <= -1_000
}

function normalizeVisibleText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

function renderOutput(markdown: string, title: string | null | undefined): string {
  if (!markdown) return 'Readability extracted no content from this page.'

  if (title) {
    return `# ${title}\n\n${markdown}`
  }
  return markdown
}
