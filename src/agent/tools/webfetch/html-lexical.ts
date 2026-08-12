import { classifyRawInlineStyleVisibility } from './inline-style-visibility'

const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])
const OPTIONAL_SAME_TAG_CLOSE = new Set([
  'li',
  'dt',
  'dd',
  'p',
  'rt',
  'rp',
  'optgroup',
  'option',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'colgroup',
])
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes'])
// Inert template content and noscript fallback markup are not public document metadata sources.
const METADATA_SUPPRESSING_ELEMENTS = new Set(['template', 'noscript'])
// HTML integration points inside SVG/MathML are deliberately still suppressed: faithfully
// switching tokenizer namespaces is unnecessary risk for metadata-only extraction.
const FOREIGN_ROOT_ELEMENTS = new Set(['svg', 'math'])
const MAX_DOCTYPE_CHARS = 4_096
const MAX_XML_DECLARATION_CHARS = 1_024
const MAX_BOGUS_COMMENT_CHARS = 64 * 1024

type HtmlStartTag = {
  name: string
  end: number
  typeAttribute: string | null
  metadataSuppressing: boolean
  selfClosingSyntax: boolean
}

export type HtmlRawElement = {
  name: string
  typeAttribute: string | null
  bodyStart: number
  bodyEnd: number
  metadataSuppressed: boolean
}

type HtmlLexicalWalkOptions = {
  maxTags?: number
  maxDepth?: number
  maxAttributesPerTag?: number
  maxStartTagChars?: number
  allowIncompleteTail?: boolean
  onStartTag?: (tag: { name: string; end: number }) => void
  onRawElement?: (element: HtmlRawElement) => void
}

export type HtmlLexicalWalkResult = { valid: true } | { valid: false; failure: 'limit' | 'malformed' }

type ParseResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'text' }
  | { kind: 'incomplete' }
  | { kind: 'invalid' }
  | { kind: 'limit' }

type StackEntry = {
  name: string
  metadataSuppressing: boolean
  foreignRoot: boolean
}

export function walkHtmlLexically(html: string, options: HtmlLexicalWalkOptions = {}): HtmlLexicalWalkResult {
  const stack: StackEntry[] = []
  let metadataSuppressionDepth = 0
  let foreignNamespaceDepth = 0
  let tagCount = 0
  let cursor = 0
  let xmlDeclarationAllowed = true

  const recordTag = (): boolean => {
    tagCount++
    return options.maxTags === undefined || tagCount <= options.maxTags
  }

  const popStack = (): StackEntry | undefined => {
    const closed = stack.pop()
    if (closed?.metadataSuppressing) metadataSuppressionDepth--
    if (closed?.foreignRoot) foreignNamespaceDepth--
    return closed
  }

  const popThrough = (index: number): void => {
    while (stack.length > index) popStack()
  }

  const closeOptionalElementsForStart = (name: string): void => {
    const current = stack.at(-1)?.name
    if ((name === 'dt' || name === 'dd') && (current === 'dt' || current === 'dd')) {
      popStack()
      return
    }
    if (name === 'tr') {
      const row = findOpenTableEntry(stack, new Set(['tr']), new Set(['table', 'thead', 'tbody', 'tfoot']))
      if (row >= 0) popThrough(row)
      return
    }
    if (name === 'thead' || name === 'tbody' || name === 'tfoot') {
      const priorTableContent = findOpenTableEntry(stack, new Set(['thead', 'tbody', 'tfoot']), new Set(['table']))
      if (priorTableContent >= 0) popThrough(priorTableContent)
      return
    }
    if (name === 'td' || name === 'th') {
      const cell = findOpenTableEntry(stack, new Set(['td', 'th']), new Set(['tr', 'table']))
      if (cell >= 0) popThrough(cell)
      return
    }
    if (OPTIONAL_SAME_TAG_CLOSE.has(name) && current === name) popStack()
  }

  const closeTableEndTag = (name: string): boolean => {
    const target = findTableEndTarget(stack, name)
    if (target < 0) return false
    popThrough(target)
    return true
  }

  while (cursor < html.length) {
    const open = html.indexOf('<', cursor)
    if (open < 0) break
    if (xmlDeclarationAllowed && !isIgnorablePrologText(html.slice(cursor, open))) xmlDeclarationAllowed = false

    if (html.startsWith('<!--', open)) {
      const comment = parseComment(html, open)
      if (comment.kind === 'ok') {
        xmlDeclarationAllowed = false
        cursor = comment.value
        continue
      }
      if (comment.kind === 'incomplete' && options.allowIncompleteTail) break
      return malformed()
    }

    if (html[open + 1] === '!') {
      const declaration = parseDoctype(html, open)
      if (declaration.kind === 'ok') {
        xmlDeclarationAllowed = false
        cursor = declaration.value
        continue
      }
      if (declaration.kind === 'invalid') {
        const comment = parseBogusComment(html, open)
        if (comment.kind === 'ok') {
          xmlDeclarationAllowed = false
          cursor = comment.value
          continue
        }
        if (comment.kind === 'limit') return limitExceeded()
        if (comment.kind === 'incomplete' && options.allowIncompleteTail) break
      }
      if (declaration.kind === 'incomplete' && options.allowIncompleteTail) break
      return malformed()
    }

    if (html[open + 1] === '?') {
      if (xmlDeclarationAllowed && html.startsWith('<?xml', open)) {
        const declaration = parseXmlDeclaration(html, open)
        if (declaration.kind === 'ok') {
          xmlDeclarationAllowed = false
          cursor = declaration.value
          continue
        }
      }
      const comment = parseBogusComment(html, open)
      if (comment.kind === 'ok') {
        xmlDeclarationAllowed = false
        cursor = comment.value
        continue
      }
      if (comment.kind === 'limit') return limitExceeded()
      if (comment.kind === 'incomplete' && options.allowIncompleteTail) break
      return malformed()
    }

    if (html[open + 1] === '/') {
      xmlDeclarationAllowed = false
      const closingTag = parseClosingTag(html, open)
      if (closingTag.kind === 'text') {
        cursor = open + 1
        continue
      }
      if (closingTag.kind === 'incomplete' && options.allowIncompleteTail) break
      if (closingTag.kind !== 'ok') return malformed()
      if (!recordTag()) return limitExceeded()

      if (!closeTableEndTag(closingTag.value.name)) {
        const target = findLastOpenElement(stack, closingTag.value.name)
        if (target >= 0 && stack.slice(target + 1).every(({ name }) => OPTIONAL_SAME_TAG_CLOSE.has(name))) {
          popThrough(target)
        }
      }
      cursor = closingTag.value.end + 1
      continue
    }

    xmlDeclarationAllowed = false
    const openingTag = parseOpeningTag(html, open, options)
    if (openingTag.kind === 'text') {
      cursor = open + 1
      continue
    }
    if (openingTag.kind === 'incomplete' && options.allowIncompleteTail) break
    if (openingTag.kind === 'limit') return limitExceeded()
    if (openingTag.kind !== 'ok') return malformed()
    if (!recordTag()) return limitExceeded()

    const tag = openingTag.value
    options.onStartTag?.({ name: tag.name, end: tag.end })
    if (!VOID_ELEMENTS.has(tag.name)) {
      closeOptionalElementsForStart(tag.name)
      const inForeignContent = foreignNamespaceDepth > 0
      const metadataSuppressed = metadataSuppressionDepth > 0 || foreignNamespaceDepth > 0
      const entry = {
        name: tag.name,
        metadataSuppressing: METADATA_SUPPRESSING_ELEMENTS.has(tag.name) || tag.metadataSuppressing,
        foreignRoot: FOREIGN_ROOT_ELEMENTS.has(tag.name),
      }
      stack.push(entry)
      if (entry.metadataSuppressing) metadataSuppressionDepth++
      if (entry.foreignRoot) foreignNamespaceDepth++
      if (options.maxDepth !== undefined && stack.length > options.maxDepth) return limitExceeded()

      cursor = tag.end + 1
      if ((inForeignContent || entry.foreignRoot) && tag.selfClosingSyntax) {
        popStack()
        continue
      }
      if (tag.name === 'plaintext' && !inForeignContent) return { valid: true }
      if (!RAW_TEXT_ELEMENTS.has(tag.name) || (inForeignContent && tag.name !== 'style')) continue

      const closeStart =
        tag.name === 'script' ? findScriptClosingTagStart(html, cursor) : findRawClosingTagStart(html, tag.name, cursor)
      if (closeStart < 0) break
      const closingTag = parseClosingTag(html, closeStart)
      if (closingTag.kind === 'incomplete' && options.allowIncompleteTail) break
      if (closingTag.kind !== 'ok') return malformed()

      options.onRawElement?.({
        name: tag.name,
        typeAttribute: tag.typeAttribute,
        bodyStart: cursor,
        bodyEnd: closeStart,
        metadataSuppressed: metadataSuppressed || entry.metadataSuppressing,
      })

      if (!recordTag()) return limitExceeded()
      if (stack.at(-1)?.name === tag.name) popStack()
      cursor = closingTag.value.end + 1
      continue
    }

    cursor = tag.end + 1
  }

  return { valid: true }
}

function parseComment(html: string, open: number): ParseResult<number> {
  let cursor = open + 4
  if (html[cursor] === '>' || html.startsWith('->', cursor)) return { kind: 'invalid' }

  while (cursor < html.length) {
    if (html.startsWith('-->', cursor)) return { kind: 'ok', value: cursor + 3 }
    if (html.startsWith('<!--', cursor) || html.startsWith('--', cursor)) return { kind: 'invalid' }
    cursor++
  }
  return { kind: 'incomplete' }
}

function parseBogusComment(html: string, open: number): ParseResult<number> {
  const end = html.indexOf('>', open + 2)
  if (end < 0) return html.length - open > MAX_BOGUS_COMMENT_CHARS ? { kind: 'limit' } : { kind: 'incomplete' }
  if (end - open > MAX_BOGUS_COMMENT_CHARS) return { kind: 'limit' }
  return { kind: 'ok', value: end + 1 }
}

function parseDoctype(html: string, open: number): ParseResult<number> {
  const keywordEnd = open + 9
  if (!startsWithAsciiInsensitive(html, '<!doctype', open) || !isHtmlWhitespace(html[keywordEnd])) {
    return { kind: 'invalid' }
  }

  const terminator = findQuoteAwareTerminator(html, keywordEnd, '>', MAX_DOCTYPE_CHARS)
  if (terminator.kind !== 'ok') return terminator

  let cursor = skipHtmlWhitespace(html, keywordEnd)
  if (!startsWithAsciiInsensitive(html, 'html', cursor) || !isDoctypeNameBoundary(html[cursor + 4])) {
    return { kind: 'invalid' }
  }
  cursor += 4
  cursor = skipHtmlWhitespace(html, cursor)
  if (cursor === terminator.value) return { kind: 'ok', value: terminator.value + 1 }

  const externalIdStart = cursor
  while (isAsciiLetter(html[cursor])) cursor++
  const externalIdKind = asciiFoldSlice(html, externalIdStart, cursor)
  if ((externalIdKind !== 'public' && externalIdKind !== 'system') || !isHtmlWhitespace(html[cursor])) {
    return { kind: 'invalid' }
  }
  cursor = skipHtmlWhitespace(html, cursor)

  const firstIdentifier = consumeQuotedValue(html, cursor, terminator.value)
  if (firstIdentifier.kind !== 'ok') return { kind: 'invalid' }
  cursor = skipHtmlWhitespace(html, firstIdentifier.value)

  if (externalIdKind === 'public' && cursor < terminator.value) {
    const systemIdentifier = consumeQuotedValue(html, cursor, terminator.value)
    if (systemIdentifier.kind !== 'ok') return { kind: 'invalid' }
    cursor = skipHtmlWhitespace(html, systemIdentifier.value)
  }
  if (cursor !== terminator.value) return { kind: 'invalid' }
  return { kind: 'ok', value: terminator.value + 1 }
}

function parseXmlDeclaration(html: string, open: number): ParseResult<number> {
  if (!html.startsWith('<?xml', open) || !isHtmlWhitespace(html[open + 5])) return { kind: 'invalid' }

  const terminator = findQuoteAwareTerminator(html, open + 5, '?>', MAX_XML_DECLARATION_CHARS)
  if (terminator.kind !== 'ok') return terminator

  const attributes: Array<{ name: string; value: string }> = []
  let cursor = open + 5
  while (cursor < terminator.value) {
    if (!isHtmlWhitespace(html[cursor])) return { kind: 'invalid' }
    cursor = skipHtmlWhitespace(html, cursor)
    if (cursor === terminator.value) break

    const nameStart = cursor
    while (isXmlNameCharacter(html[cursor])) cursor++
    if (cursor === nameStart) return { kind: 'invalid' }
    const name = html.slice(nameStart, cursor)
    cursor = skipHtmlWhitespace(html, cursor)
    if (html[cursor] !== '=') return { kind: 'invalid' }
    cursor = skipHtmlWhitespace(html, cursor + 1)

    const valueStart = cursor
    const quoted = consumeQuotedValue(html, cursor, terminator.value)
    if (quoted.kind !== 'ok') return { kind: 'invalid' }
    const quote = html[valueStart]
    attributes.push({ name, value: html.slice(valueStart + 1, quoted.value - 1) })
    if (quote !== '"' && quote !== "'") return { kind: 'invalid' }
    cursor = quoted.value
  }

  if (attributes.length < 1 || attributes.length > 3) return { kind: 'invalid' }
  if (attributes[0]?.name !== 'version' || attributes[0].value !== '1.0') return { kind: 'invalid' }
  if (attributes[1]?.name === 'encoding' && !/^[A-Za-z][A-Za-z0-9._-]*$/u.test(attributes[1].value)) {
    return { kind: 'invalid' }
  }
  const standalone = attributes.find(({ name }) => name === 'standalone')
  if (standalone !== undefined && standalone.value !== 'yes' && standalone.value !== 'no') {
    return { kind: 'invalid' }
  }
  const expectedNames = [
    'version',
    ...(attributes.some(({ name }) => name === 'encoding') ? ['encoding'] : []),
    ...(standalone === undefined ? [] : ['standalone']),
  ]
  if (attributes.some(({ name }, index) => name !== expectedNames[index])) return { kind: 'invalid' }
  return { kind: 'ok', value: terminator.value + 2 }
}

function findQuoteAwareTerminator(
  html: string,
  from: number,
  terminator: '>' | '?>',
  maxChars: number,
): ParseResult<number> {
  const limit = Math.min(html.length, from + maxChars)
  let quote: '"' | "'" | null = null
  let cursor = from

  while (cursor < limit) {
    const char = html[cursor]
    if (char === '<') return { kind: 'invalid' }
    if (quote !== null) {
      if (char === quote) quote = null
      cursor++
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      cursor++
      continue
    }
    if (html.startsWith(terminator, cursor)) return { kind: 'ok', value: cursor }
    cursor++
  }

  return limit < html.length ? { kind: 'invalid' } : { kind: 'incomplete' }
}

function consumeQuotedValue(html: string, from: number, end: number): ParseResult<number> {
  const quote = html[from]
  if (quote !== '"' && quote !== "'") return { kind: 'invalid' }

  let cursor = from + 1
  while (cursor < end) {
    if (html[cursor] === '<') return { kind: 'invalid' }
    if (html[cursor] === quote) return { kind: 'ok', value: cursor + 1 }
    cursor++
  }
  return { kind: 'invalid' }
}

function parseOpeningTag(
  html: string,
  open: number,
  limits: Pick<HtmlLexicalWalkOptions, 'maxAttributesPerTag' | 'maxStartTagChars'>,
): ParseResult<HtmlStartTag> {
  const nameStart = open + 1
  if (!isAsciiLetter(html[nameStart])) return { kind: 'text' }

  const nameEnd = consumeTagName(html, nameStart)
  if (!isTagBoundary(html[nameEnd])) return { kind: 'invalid' }
  const name = asciiFoldSlice(html, nameStart, nameEnd)
  let typeAttribute: string | null = null
  let typeAttributeSeen = false
  let ariaHiddenAttributeSeen = false
  let styleAttributeSeen = false
  let openAttributeSeen = false
  let metadataSuppressing = false
  let cursor = nameEnd
  let attributeCount = 0
  const exceedsStartTagLimit = (position: number): boolean =>
    limits.maxStartTagChars !== undefined && position - open > limits.maxStartTagChars

  while (cursor < html.length) {
    if (exceedsStartTagLimit(cursor)) return { kind: 'limit' }
    cursor = skipHtmlWhitespace(html, cursor)
    if (exceedsStartTagLimit(cursor)) return { kind: 'limit' }
    const char = html[cursor]
    if (char === '>')
      return {
        kind: 'ok',
        value: {
          name,
          end: cursor,
          typeAttribute,
          metadataSuppressing: metadataSuppressing || (isClosedNativeContainer(name) && !openAttributeSeen),
          selfClosingSyntax: false,
        },
      }
    if (char === undefined) return { kind: 'incomplete' }
    if (char === '/') {
      if (html[cursor + 1] === '>') {
        return {
          kind: 'ok',
          value: {
            name,
            end: cursor + 1,
            typeAttribute,
            metadataSuppressing: metadataSuppressing || (isClosedNativeContainer(name) && !openAttributeSeen),
            selfClosingSyntax: true,
          },
        }
      }
      return { kind: 'invalid' }
    }
    if (char === '<' || char === '=' || char === '"' || char === "'") return { kind: 'invalid' }

    const attributeStart = cursor
    while (cursor < html.length && !isAttributeNameBoundary(html[cursor])) {
      cursor++
      if (exceedsStartTagLimit(cursor)) return { kind: 'limit' }
    }
    if (cursor === attributeStart) return { kind: 'invalid' }
    attributeCount++
    if (limits.maxAttributesPerTag !== undefined && attributeCount > limits.maxAttributesPerTag) {
      return { kind: 'limit' }
    }
    const attributeName = asciiFoldSlice(html, attributeStart, cursor)
    cursor = skipHtmlWhitespace(html, cursor)

    let attributeValue: string | null = null
    let attributeValueUncertain = false
    if (html[cursor] === '=') {
      cursor = skipHtmlWhitespace(html, cursor + 1)
      const quote = html[cursor]
      if (quote === '"' || quote === "'") {
        const valueStart = ++cursor
        while (cursor < html.length && html[cursor] !== quote) {
          cursor++
          if (exceedsStartTagLimit(cursor)) return { kind: 'limit' }
        }
        if (cursor >= html.length) return { kind: 'incomplete' }
        const rawAttributeValue = html.slice(valueStart, cursor)
        attributeValue = decodeRelevantAttributeValue(rawAttributeValue)
        attributeValueUncertain = attributeValue === null && rawAttributeValue.includes('&')
        cursor++
      } else {
        const valueStart = cursor
        while (cursor < html.length && !isUnquotedAttributeBoundary(html[cursor])) {
          if (isInvalidUnquotedAttributeCharacter(html[cursor])) return { kind: 'invalid' }
          cursor++
          if (exceedsStartTagLimit(cursor)) return { kind: 'limit' }
        }
        if (cursor === valueStart) return { kind: 'invalid' }
        const rawAttributeValue = html.slice(valueStart, cursor)
        attributeValue = decodeRelevantAttributeValue(rawAttributeValue)
        attributeValueUncertain = attributeValue === null && rawAttributeValue.includes('&')
      }
    }

    if (attributeName === 'type' && !typeAttributeSeen) {
      typeAttributeSeen = true
      typeAttribute = attributeValue === null ? null : asciiFold(trimHtmlWhitespace(attributeValue))
    }
    if (attributeName === 'open') openAttributeSeen = true
    if (attributeName === 'hidden' || attributeName === 'inert') metadataSuppressing = true
    if (attributeName === 'aria-hidden' && !ariaHiddenAttributeSeen) {
      ariaHiddenAttributeSeen = true
      if (asciiFold(attributeValue?.trim() ?? '') === 'true') metadataSuppressing = true
    }
    if (attributeName === 'style' && !styleAttributeSeen) {
      styleAttributeSeen = true
      if (
        attributeValueUncertain ||
        (attributeValue !== null && classifyRawInlineStyleVisibility(attributeValue) !== 'visible')
      ) {
        metadataSuppressing = true
      }
    }
  }

  return { kind: 'incomplete' }
}

function isClosedNativeContainer(name: string): boolean {
  return name === 'details' || name === 'dialog'
}

function findLastOpenElement(stack: StackEntry[], name: string): number {
  for (let index = stack.length - 1; index >= 0; index--) {
    if (stack[index]?.name === name) return index
  }
  return -1
}

function parseClosingTag(html: string, open: number): ParseResult<{ name: string; end: number }> {
  const nameStart = open + 2
  if (!isAsciiLetter(html[nameStart])) return { kind: 'invalid' }

  const nameEnd = consumeTagName(html, nameStart)
  if (!isTagBoundary(html[nameEnd])) return { kind: 'invalid' }
  const end = skipHtmlWhitespace(html, nameEnd)
  if (html[end] === undefined) return { kind: 'incomplete' }
  if (html[end] !== '>') return { kind: 'invalid' }
  return { kind: 'ok', value: { name: asciiFoldSlice(html, nameStart, nameEnd), end } }
}

function findRawClosingTagStart(html: string, name: string, from: number): number {
  const prefix = `</${name}`
  let cursor = from
  while (cursor < html.length) {
    const index = html.indexOf('<', cursor)
    if (index < 0) return -1
    if (startsWithAsciiInsensitive(html, prefix, index) && isTagBoundary(html[index + prefix.length])) return index
    cursor = index + 1
  }
  return -1
}

function findScriptClosingTagStart(html: string, from: number): number {
  type ScriptState = 'data' | 'escaped' | 'double-escaped'

  let state: ScriptState = 'data'
  let cursor = from
  while (cursor < html.length) {
    if (state === 'data') {
      if (html.startsWith('<!--', cursor)) {
        state = 'escaped'
        cursor += 4
        continue
      }
      if (isScriptEndTagAt(html, cursor)) return cursor
    } else if (state === 'escaped') {
      if (html.startsWith('-->', cursor)) {
        state = 'data'
        cursor += 3
        continue
      }
      if (isScriptStartTagAt(html, cursor)) {
        state = 'double-escaped'
        cursor += 7
        continue
      }
      if (isScriptEndTagAt(html, cursor)) return cursor
    } else if (isScriptEndTagAt(html, cursor)) {
      state = 'escaped'
      cursor += 8
      continue
    }
    cursor++
  }
  return -1
}

function isScriptStartTagAt(html: string, cursor: number): boolean {
  const prefix = '<script'
  return startsWithAsciiInsensitive(html, prefix, cursor) && isTagBoundary(html[cursor + prefix.length])
}

function isScriptEndTagAt(html: string, cursor: number): boolean {
  const prefix = '</script'
  return startsWithAsciiInsensitive(html, prefix, cursor) && isTagBoundary(html[cursor + prefix.length])
}

function findOpenTableEntry(stack: StackEntry[], targets: Set<string>, boundaries: Set<string>): number {
  for (let index = stack.length - 1; index >= 0; index--) {
    const entry = stack[index]!
    if (entry.metadataSuppressing || entry.foreignRoot) return -1
    const name = entry.name
    if (targets.has(name)) return index
    if (boundaries.has(name)) return -1
  }
  return -1
}

function findTableEndTarget(stack: StackEntry[], name: string): number {
  const isSection = name === 'thead' || name === 'tbody' || name === 'tfoot'
  if (!isSection && name !== 'table') return -1

  const allowed = isSection ? new Set(['tr', 'td', 'th']) : new Set(['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'])
  for (let index = stack.length - 1; index >= 0; index--) {
    const entry = stack[index]!
    if (entry.metadataSuppressing || entry.foreignRoot) return -1
    if (entry.name === name) return index
    if (!allowed.has(entry.name)) return -1
  }
  return -1
}

function consumeTagName(html: string, from: number): number {
  let cursor = from
  while (isTagNameCharacter(html[cursor])) cursor++
  return cursor
}

function skipHtmlWhitespace(html: string, from: number): number {
  let cursor = from
  while (isHtmlWhitespace(html[cursor])) cursor++
  return cursor
}

function isAsciiLetter(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z]/u.test(char)
}

function isTagNameCharacter(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9:_-]/u.test(char)
}

function isXmlNameCharacter(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z]/u.test(char)
}

function isHtmlWhitespace(char: string | undefined): boolean {
  return char === '\t' || char === '\n' || char === '\f' || char === '\r' || char === ' '
}

function isTagBoundary(char: string | undefined): boolean {
  return char === undefined || isHtmlWhitespace(char) || char === '/' || char === '>'
}

function isDoctypeNameBoundary(char: string | undefined): boolean {
  return isHtmlWhitespace(char) || char === '>'
}

function isAttributeNameBoundary(char: string | undefined): boolean {
  return char === undefined || isHtmlWhitespace(char) || char === '/' || char === '>' || char === '='
}

function isUnquotedAttributeBoundary(char: string | undefined): boolean {
  return char === undefined || isHtmlWhitespace(char) || char === '>'
}

function isInvalidUnquotedAttributeCharacter(char: string | undefined): boolean {
  return char === '<' || char === '=' || char === '"' || char === "'" || char === '`'
}

function isIgnorablePrologText(value: string): boolean {
  return /^\uFEFF?[\t\n\f\r ]*$/u.test(value)
}

function trimHtmlWhitespace(value: string): string {
  return value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/gu, '')
}

function asciiFoldSlice(value: string, start: number, end: number): string {
  let folded = ''
  for (let index = start; index < end; index++) folded += asciiFoldCharacter(value[index])
  return folded
}

function asciiFold(value: string): string {
  let folded = ''
  for (const char of value) folded += asciiFoldCharacter(char)
  return folded
}

const NAMED_ATTRIBUTE_REFERENCES: Readonly<Record<string, string>> = {
  amp: '&',
  apos: "'",
  colon: ':',
  gt: '>',
  lt: '<',
  quot: '"',
  sol: '/',
}

const WINDOWS_1252_REFERENCES: Readonly<Record<number, number>> = {
  0x80: 0x20ac,
  0x82: 0x201a,
  0x83: 0x0192,
  0x84: 0x201e,
  0x85: 0x2026,
  0x86: 0x2020,
  0x87: 0x2021,
  0x88: 0x02c6,
  0x89: 0x2030,
  0x8a: 0x0160,
  0x8b: 0x2039,
  0x8c: 0x0152,
  0x8e: 0x017d,
  0x91: 0x2018,
  0x92: 0x2019,
  0x93: 0x201c,
  0x94: 0x201d,
  0x95: 0x2022,
  0x96: 0x2013,
  0x97: 0x2014,
  0x98: 0x02dc,
  0x99: 0x2122,
  0x9a: 0x0161,
  0x9b: 0x203a,
  0x9c: 0x0153,
  0x9e: 0x017e,
  0x9f: 0x0178,
}

function decodeRelevantAttributeValue(value: string): string | null {
  let decoded = ''
  let cursor = 0
  while (cursor < value.length) {
    const ampersand = value.indexOf('&', cursor)
    if (ampersand < 0) return decoded + value.slice(cursor)
    decoded += value.slice(cursor, ampersand)
    const numeric = consumeNumericAttributeReference(value, ampersand)
    if (numeric !== null) {
      decoded += numeric.replacement
      cursor = numeric.end
      continue
    }

    const semicolon = value.indexOf(';', ampersand + 1)
    if (semicolon < 0 || semicolon - ampersand > 32) return null
    const replacement = NAMED_ATTRIBUTE_REFERENCES[asciiFold(value.slice(ampersand + 1, semicolon))]
    if (replacement === undefined) return null
    decoded += replacement
    cursor = semicolon + 1
  }
  return decoded
}

function consumeNumericAttributeReference(
  value: string,
  ampersand: number,
): { replacement: string; end: number } | null {
  if (value[ampersand + 1] !== '#') return null
  const hexadecimal = value[ampersand + 2] === 'x' || value[ampersand + 2] === 'X'
  const digitStart = ampersand + (hexadecimal ? 3 : 2)
  let digitEnd = digitStart
  while (hexadecimal ? isAsciiHexDigit(value[digitEnd]) : isAsciiDigit(value[digitEnd])) digitEnd++
  if (digitEnd === digitStart || digitEnd - ampersand > 32) return null

  const digits = value.slice(digitStart, digitEnd)
  const parsed = Number.parseInt(digits, hexadecimal ? 16 : 10)
  const remapped = WINDOWS_1252_REFERENCES[parsed] ?? parsed
  const replacement =
    remapped === 0 || remapped > 0x10ffff || (remapped >= 0xd800 && remapped <= 0xdfff)
      ? '\uFFFD'
      : String.fromCodePoint(remapped)
  return { replacement, end: value[digitEnd] === ';' ? digitEnd + 1 : digitEnd }
}

function isAsciiDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9'
}

function isAsciiHexDigit(char: string | undefined): boolean {
  return (
    isAsciiDigit(char) || (char !== undefined && asciiFoldCharacter(char) >= 'a' && asciiFoldCharacter(char) <= 'f')
  )
}

function startsWithAsciiInsensitive(value: string, expectedLowercase: string, start: number): boolean {
  if (start + expectedLowercase.length > value.length) return false
  for (let index = 0; index < expectedLowercase.length; index++) {
    if (asciiFoldCharacter(value[start + index]) !== expectedLowercase[index]) return false
  }
  return true
}

function asciiFoldCharacter(char: string | undefined): string {
  if (char === undefined) return ''
  const code = char.charCodeAt(0)
  return code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : char
}

function malformed(): HtmlLexicalWalkResult {
  return { valid: false, failure: 'malformed' }
}

function limitExceeded(): HtmlLexicalWalkResult {
  return { valid: false, failure: 'limit' }
}
