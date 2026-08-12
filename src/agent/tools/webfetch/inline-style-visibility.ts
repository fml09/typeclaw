export type InlineStyleVisibility = 'hidden' | 'visible' | 'uncertain'

const MAX_RAW_INLINE_STYLE_CHARS = 64 * 1024
const MAX_CSS_NESTING_DEPTH = 32
const RELEVANT_PROPERTIES = new Set(['content-visibility', 'display', 'visibility', 'opacity'])
const CSS_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/iu
const CSS_PERCENTAGE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?%$/iu
const VISIBLE_DISPLAY_VALUES = new Set([
  'block',
  'contents',
  'flex',
  'flow-root',
  'grid',
  'inline',
  'inline-block',
  'inline-flex',
  'inline-grid',
  'inline-table',
  'list-item',
  'ruby',
  'ruby-base',
  'ruby-base-container',
  'ruby-text',
  'ruby-text-container',
  'table',
  'table-caption',
  'table-cell',
  'table-column',
  'table-column-group',
  'table-footer-group',
  'table-header-group',
  'table-row',
  'table-row-group',
])

type RelevantDeclaration = {
  importance: 'normal' | 'important' | 'uncertain'
  visibility: InlineStyleVisibility
}

// The result covers only deterministic inline display, visibility, opacity, and content visibility.
// "Uncertain" means a relevant declaration cannot be safely classified and callers
// handling public extraction should suppress it just like "hidden".
export function classifyRawInlineStyleVisibility(style: string): InlineStyleVisibility {
  if (style.length > MAX_RAW_INLINE_STYLE_CHARS) return 'uncertain'
  const scanned = scanDeclarations(style)
  if (scanned === null) return 'uncertain'

  const declarations = new Map<string, RelevantDeclaration[]>()
  for (const { rawProperty, rawValue } of scanned) {
    const decodedProperty = decodeCssEscapes(rawProperty)
    if (!decodedProperty.valid) {
      if (!rawProperty.trimStart().startsWith('--')) return 'uncertain'
      continue
    }
    const property = asciiFold(decodedProperty.value.trim())
    if (!RELEVANT_PROPERTIES.has(property)) continue

    const declaration = classifyDeclaration(property, rawValue)
    const prior = declarations.get(property)
    if (prior === undefined) declarations.set(property, [declaration])
    else prior.push(declaration)
  }

  let result: InlineStyleVisibility = 'visible'
  for (const propertyDeclarations of declarations.values()) {
    const winner = winningDeclaration(propertyDeclarations)
    if (winner === 'hidden') return 'hidden'
    if (winner === 'uncertain') result = 'uncertain'
  }
  return result
}

type ScannedDeclaration = { rawProperty: string; rawValue: string }

function scanDeclarations(style: string): ScannedDeclaration[] | null {
  const declarations: ScannedDeclaration[] = []
  let declaration: string[] = []
  let separator = -1
  let quote: '"' | "'" | null = null
  const blocks: string[] = []
  let cursor = 0

  const finishDeclaration = (): void => {
    if (separator >= 0) {
      const source = declaration.join('')
      declarations.push({ rawProperty: source.slice(0, separator), rawValue: source.slice(separator + 1) })
    }
    declaration = []
    separator = -1
  }

  while (cursor < style.length) {
    const char = style[cursor]!
    if (char === '\\') {
      const escaped = style[cursor + 1]
      if (escaped === undefined) return null
      if (isCssNewline(escaped)) {
        cursor += escaped === '\r' && style[cursor + 2] === '\n' ? 3 : 2
        continue
      }
      declaration.push(char, escaped)
      cursor += 2
      continue
    }
    if (quote !== null) {
      declaration.push(char)
      if (char === quote) quote = null
      cursor++
      continue
    }
    if (style.startsWith('/*', cursor)) {
      const end = style.indexOf('*/', cursor + 2)
      if (end < 0) return null
      declaration.push(' ')
      cursor = end + 2
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      declaration.push(char)
      cursor++
      continue
    }
    if (char === '(' || char === '[' || char === '{') {
      blocks.push(char)
      if (blocks.length > MAX_CSS_NESTING_DEPTH) return null
      declaration.push(char)
      cursor++
      continue
    }
    if (char === ')' || char === ']' || char === '}') {
      if (blocks.pop() !== matchingBlockStart(char)) return null
      declaration.push(char)
      cursor++
      continue
    }
    if (blocks.length === 0 && char === ':' && separator < 0) separator = declaration.length
    if (blocks.length === 0 && char === ';') finishDeclaration()
    else declaration.push(char)
    cursor++
  }

  if (quote !== null || blocks.length !== 0) return null
  finishDeclaration()
  return declarations
}

function classifyDeclaration(property: string, rawValue: string): RelevantDeclaration {
  const decoded = decodeCssEscapes(rawValue)
  if (!decoded.valid) return { importance: 'normal', visibility: 'uncertain' }

  const important = extractImportance(decoded.value)
  if (important.importance === 'uncertain') return { importance: 'uncertain', visibility: 'uncertain' }
  const value = asciiFold(important.value.trim())

  return {
    importance: important.importance,
    visibility:
      property === 'opacity'
        ? classifyOpacity(value)
        : property === 'content-visibility'
          ? classifyContentVisibility(value)
          : property === 'display'
            ? classifyDisplay(value)
            : classifyVisibility(value),
  }
}

function classifyContentVisibility(value: string): InlineStyleVisibility {
  if (value === 'hidden') return 'hidden'
  if (value === 'visible' || value === 'auto' || value === 'initial') return 'visible'
  return 'uncertain'
}

function winningDeclaration(declarations: RelevantDeclaration[]): InlineStyleVisibility {
  if (declarations.some(({ importance }) => importance === 'uncertain')) return 'uncertain'
  const important = declarations.filter(({ importance }) => importance === 'important')
  return (important.length > 0 ? important : declarations).at(-1)?.visibility ?? 'visible'
}

function classifyDisplay(value: string): InlineStyleVisibility {
  if (value === 'none') return 'hidden'
  if (value === 'initial') return 'visible'
  return VISIBLE_DISPLAY_VALUES.has(value) ? 'visible' : 'uncertain'
}

function classifyVisibility(value: string): InlineStyleVisibility {
  if (value === 'hidden' || value === 'collapse') return 'hidden'
  if (value === 'visible' || value === 'initial') return 'visible'
  return 'uncertain'
}

function classifyOpacity(value: string): InlineStyleVisibility {
  if (value === 'initial') return 'visible'
  const simpleCalc = /^calc\(\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?%?)\s*\)$/iu.exec(value)
  const numeric = simpleCalc?.[1] ?? value
  if (!CSS_NUMBER.test(numeric) && !CSS_PERCENTAGE.test(numeric)) return 'uncertain'
  const number = Number(numeric.endsWith('%') ? numeric.slice(0, -1) : numeric)
  if (!Number.isFinite(number)) return 'uncertain'
  if (simpleCalc !== null) return number === 0 ? 'hidden' : 'uncertain'
  return number <= 0 ? 'hidden' : 'visible'
}

function extractImportance(value: string): {
  importance: 'normal' | 'important' | 'uncertain'
  value: string
} {
  const marker = /!\s*important\s*$/iu.exec(value)
  if (marker !== null) {
    const before = value.slice(0, marker.index)
    return { importance: before.includes('!') ? 'uncertain' : 'important', value: before }
  }
  return value.includes('!') ? { importance: 'uncertain', value } : { importance: 'normal', value }
}

function decodeCssEscapes(value: string): { valid: true; value: string } | { valid: false } {
  let decoded = ''
  let cursor = 0
  while (cursor < value.length) {
    const char = value[cursor]!
    if (char !== '\\') {
      decoded += char
      cursor++
      continue
    }

    cursor++
    const escaped = value[cursor]
    if (escaped === undefined) return { valid: false }
    if (isCssNewline(escaped)) {
      cursor += escaped === '\r' && value[cursor + 1] === '\n' ? 2 : 1
      continue
    }
    if (!isAsciiHexDigit(escaped)) {
      decoded += escaped
      cursor++
      continue
    }

    const hexStart = cursor
    while (cursor < value.length && cursor - hexStart < 6 && isAsciiHexDigit(value[cursor]!)) cursor++
    const codePoint = Number.parseInt(value.slice(hexStart, cursor), 16)
    decoded +=
      codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)
        ? '\uFFFD'
        : String.fromCodePoint(codePoint)
    if (isCssWhitespace(value[cursor])) {
      if (value[cursor] === '\r' && value[cursor + 1] === '\n') cursor++
      cursor++
    }
  }
  return { valid: true, value: decoded }
}

function isAsciiHexDigit(char: string): boolean {
  const code = char.charCodeAt(0)
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102)
}

function isCssWhitespace(char: string | undefined): boolean {
  return char === '\t' || char === '\n' || char === '\f' || char === '\r' || char === ' '
}

function isCssNewline(char: string): boolean {
  return char === '\n' || char === '\r' || char === '\f'
}

function matchingBlockStart(close: ')' | ']' | '}'): '(' | '[' | '{' {
  if (close === ')') return '('
  return close === ']' ? '[' : '{'
}

function asciiFold(value: string): string {
  let folded = ''
  for (const char of value) {
    const code = char.charCodeAt(0)
    folded += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : char
  }
  return folded
}
