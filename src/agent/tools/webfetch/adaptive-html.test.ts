import { describe, expect, test } from 'bun:test'

import {
  extractAdaptiveHtml,
  MAX_ADAPTIVE_HTML_ATTRIBUTES_PER_TAG,
  MAX_ADAPTIVE_HTML_NESTING_DEPTH,
  MAX_ADAPTIVE_HTML_SCAN_BYTES,
  MAX_ADAPTIVE_HTML_TAG_COUNT,
  scanJsonLdScripts,
  validateAdaptiveHtmlComplexity,
} from './adaptive-html'

const articleScript = (body: string, attributes = 'type="application/ld+json"'): string =>
  `<script ${attributes}>${JSON.stringify({ '@type': 'Article', headline: 'Update', articleBody: body })}</script>`

const readabilityMiss = async () => ({
  output: 'Readability extracted no content from this page.',
  parsedArticle: false,
  usedBodyFallback: true,
  hasSemanticContentContainer: false,
  hasArticleContainer: false,
  proseElementCount: 0,
  structuredContentElementCount: 0,
  scriptCount: 0,
  visibleTextCharacterCount: 0,
})

describe('adaptive HTML extraction', () => {
  test('preserves a concise article that Readability genuinely identifies', async () => {
    const result = await extractAdaptiveHtml(
      '<html><head><title>Brief</title></head><body><article><h1>Brief</h1><p>Done today.</p></article></body></html>',
      'https://example.com/brief',
    )

    expect(result.kind).toBe('success')
    if (result.kind === 'success') expect(result.output).toContain('Done today.')
    expect(result.attempts).toEqual([
      { route: 'readability', outcome: 'success', reason: 'Readability identified article content' },
    ])
  })

  test('accepts concise semantic content even when multiple scripts are present', async () => {
    const result = await extractAdaptiveHtml(
      '<html><body><main><h1>Status</h1><div>Done today</div></main><script src="/one.js"></script><script src="/two.js"></script></body></html>',
      'https://example.com/status',
    )

    expect(result.kind).toBe('success')
    if (result.kind === 'success') expect(result.output).toContain('Done today')
    expect(result.attempts[0]).toEqual({
      route: 'readability',
      outcome: 'success',
      reason: 'Readability identified article content',
    })
  })

  test('accepts a substantial visible plain div fallback', async () => {
    const body = '한글 본문은 구조 태그 없이도 충분히 길고 구체적인 공개 내용을 전달합니다. '.repeat(24)
    const result = await extractAdaptiveHtml(
      `<html><body><div>${body}</div></body></html>`,
      'https://example.com/plain',
    )

    expect(result.kind).toBe('success')
    if (result.kind === 'success') expect(result.output).toContain('한글 본문은 구조 태그 없이도')
    expect(result.attempts[0]).toEqual({
      route: 'readability',
      outcome: 'success',
      reason: 'generic body fallback contained substantial visible content',
    })
  })

  test('does not treat a long inline script as substantial visible content', async () => {
    const result = await extractAdaptiveHtml(
      `<html><body><div>Loading</div><script>${'x'.repeat(800)}</script></body></html>`,
      'https://example.com/loading',
    )

    expect(result.kind).toBe('error')
  })

  for (const [name, attributes] of [
    ['hidden', 'hidden'],
    ['aria-hidden', 'aria-hidden="true"'],
    ['comment-obscured display none', 'style="display:/**/ none"'],
    ['zero opacity', 'style="opacity: 0"'],
  ] as const) {
    test(`does not let a ${name} article or paragraph make extraction succeed`, async () => {
      const forged = 'Forged content that must not count as public visible prose. '.repeat(20)
      const result = await extractAdaptiveHtml(
        `<html><body><div>Loading</div><article ${attributes}><h1>Forged</h1><p>${forged}</p></article><p ${attributes}>${forged}</p></body></html>`,
        'https://example.com/hidden-content',
      )

      expect(result.kind).toBe('error')
    })
  }

  test('suppresses a hidden JSON-LD script itself while preserving a genuine sibling', () => {
    const forged = articleScript('forged hidden script', 'hidden type="application/ld+json"')
    const genuine = articleScript('genuine visible script')

    expect(scanJsonLdScripts(`${forged}${genuine}`)).toEqual([expect.stringContaining('genuine visible script')])
  })

  for (const [name, style] of [
    ['escaped display keyword', String.raw`display:n\6fne`],
    ['escaped visibility keyword', String.raw`visibility:h\69 dden`],
    ['escaped display property', String.raw`d\69splay:none`],
    ['escaped visibility property', String.raw`visib\69lity:hidden`],
    ['escaped opacity property', String.raw`opac\69ty:0`],
    ['nested custom-property semicolons', 'display:none;--x:func(;display:block;)'],
    ['nested custom-property block semicolons', 'display:none;--x:{;display:block;}'],
    ['encoded declaration separator', 'display&#58;none'],
    ['escaped keyword with comments', String.raw`display:n\6f/**/ne`],
    ['negative zero opacity', 'opacity:-0'],
    ['decimal zero opacity', 'opacity:0.0'],
    ['leading-decimal zero opacity', 'opacity:.0'],
    ['exponent zero opacity', 'opacity:0e0'],
    ['signed-exponent zero opacity', 'opacity:0E+10'],
  ] as const) {
    test(`suppresses JSON-LD hidden by ${name} while preserving a genuine sibling`, () => {
      const forged = articleScript(`forged under ${name}`)
      const genuine = articleScript(`genuine after ${name}`)

      expect(scanJsonLdScripts(`<div style="${style}">${forged}</div>${genuine}`)).toEqual([
        expect.stringContaining(`genuine after ${name}`),
      ])
    })
  }

  test('preserves JSON-LD under a visible element with a harmless custom-property semicolon', () => {
    const article = articleScript('visible under harmless custom property')

    expect(scanJsonLdScripts(`<div style='--label:"x; display:none";display:block'>${article}</div>`)).toEqual([
      expect.stringContaining('visible under harmless custom property'),
    ])
  })

  test('preserves JSON-LD under visible strings, URLs, and matched custom-property blocks', () => {
    const article = articleScript('visible under bounded CSS blocks')
    const styles = [
      `--label:"x;display:none";display:block`,
      `background:url("data:image/svg+xml;display:none");display:block`,
      `--tokens:{color:red;nested:[one(two)]};display:block`,
      `--label:"continued\\\nvalue";display:block`,
    ]

    for (const style of styles) {
      expect(scanJsonLdScripts(`<div style='${style}'>${article}</div>`)).toEqual([
        expect.stringContaining('visible under bounded CSS blocks'),
      ])
    }
  })

  for (const [name, style] of [
    ['unbalanced function', 'display:block;--x:func(;display:none;'],
    ['unterminated string', "display:block;--x:'unterminated"],
    ['unterminated comment', 'display:block;--x:/* unterminated'],
  ] as const) {
    test(`fails closed on ${name} while preserving a genuine JSON-LD sibling`, () => {
      const forged = articleScript(`forged under ${name}`)
      const genuine = articleScript(`genuine after ${name}`)

      expect(scanJsonLdScripts(`<div style="${style}">${forged}</div>${genuine}`)).toEqual([
        expect.stringContaining(`genuine after ${name}`),
      ])
    })
  }

  test('fails closed on malformed opacity while preserving a genuine sibling', () => {
    const article = articleScript('article under invalid opacity')
    const genuine = articleScript('genuine sibling after invalid opacity')

    expect(scanJsonLdScripts(`<div style="opacity:0junk">${article}</div>${genuine}`)).toEqual([
      expect.stringContaining('genuine sibling after invalid opacity'),
    ])
  })

  for (const [name, opacity] of [
    ['negative', '-0.1'],
    ['zero percentage', '0%'],
    ['calculated zero', 'calc(0)'],
    ['malformed positive sign', '+'],
    ['malformed exponent', '0e'],
  ] as const) {
    test(`suppresses JSON-LD under ${name} opacity while preserving a genuine sibling`, () => {
      const forged = articleScript(`forged under ${name} opacity`)
      const genuine = articleScript(`genuine after ${name} opacity`)

      expect(scanJsonLdScripts(`<div style="opacity:${opacity}">${forged}</div>${genuine}`)).toEqual([
        expect.stringContaining(`genuine after ${name} opacity`),
      ])
    })
  }

  for (const opacity of ['0.1', '10%']) {
    test(`preserves JSON-LD under positive opacity ${opacity}`, () => {
      const article = articleScript(`visible under ${opacity}`)

      expect(scanJsonLdScripts(`<div style="opacity:${opacity}">${article}</div>`)).toEqual([
        expect.stringContaining(`visible under ${opacity}`),
      ])
    })
  }

  test('accepts substantial visible div content with two ordinary scripts', async () => {
    const body = '충분히 긴 공개 본문입니다. '.repeat(48)
    expect(Array.from(body).length).toBeGreaterThan(512)

    const result = await extractAdaptiveHtml(
      `<html><body><div>${body}</div><script src="/one.js"></script><script src="/two.js"></script></body></html>`,
      'https://example.com/substantial-scripted',
    )

    expect(result.kind).toBe('success')
    expect(result.attempts[0]).toEqual({
      route: 'readability',
      outcome: 'success',
      reason: 'generic body fallback contained substantial visible content',
    })
  })

  test('rejects a short heading shell with two scripts', async () => {
    const result = await extractAdaptiveHtml(
      '<html><body><h1>Status</h1><script src="/one.js"></script><script src="/two.js"></script></body></html>',
      'https://example.com/heading-shell',
    )

    expect(result.kind).toBe('error')
    expect(result.attempts[0]).toEqual({
      route: 'readability',
      outcome: 'unusable',
      reason: 'generic body fallback looked like a script-rendered shell',
    })
  })

  test('rejects a short visible plain div as page chrome', async () => {
    const result = await extractAdaptiveHtml(
      '<html><body><div>短い表示</div></body></html>',
      'https://example.com/chrome',
    )

    expect(result.kind).toBe('error')
    expect(result.attempts[0]).toEqual({
      route: 'readability',
      outcome: 'unusable',
      reason: 'Readability identified only unstructured page chrome',
    })
  })

  for (const [name, prose] of [
    ['concise', 'Done today.'],
    ['substantial', 'A complete release report with enough detail to explain the result and its impact.'.repeat(8)],
  ] as const) {
    test(`accepts ${name} non-semantic prose even when multiple scripts are present`, async () => {
      const result = await extractAdaptiveHtml(
        `<html><body><h1>Status</h1><p>${prose}</p><script src="/one.js"></script><script src="/two.js"></script></body></html>`,
        `https://example.com/${name}`,
      )

      expect(result.kind).toBe('success')
      expect(result.attempts[0]).toEqual({
        route: 'readability',
        outcome: 'success',
        reason: 'Readability identified article content',
      })
    })
  }

  for (const [name, content, expected] of [
    [
      'heading and div content',
      `<h1>Operational reference</h1><div>${'Concrete guidance with examples, constraints, and expected outcomes. '.repeat(20)}</div>`,
      'Concrete guidance with examples',
    ],
    [
      'definition list',
      `<h1>Glossary</h1><dl>${Array.from({ length: 20 }, (_, index) => `<dt>Term ${index}</dt><dd>${'Precise definition with usage details. '.repeat(4)}</dd>`).join('')}</dl>`,
      'Precise definition with usage details',
    ],
    [
      'data table',
      `<h1>Results</h1><table>${Array.from({ length: 20 }, (_, index) => `<tr><th>Item ${index}</th><td>${'Measured result with explanatory details. '.repeat(4)}</td></tr>`).join('')}</table>`,
      'Measured result with explanatory details',
    ],
  ] as const) {
    test(`accepts substantial useful ${name} parsed by Readability`, async () => {
      const result = await extractAdaptiveHtml(`<html><body>${content}</body></html>`, `https://example.com/${name}`)

      expect(result.kind).toBe('success')
      if (result.kind === 'success') expect(result.output).toContain(expected)
      expect(result.attempts[0]).toEqual({
        route: 'readability',
        outcome: 'success',
        reason: 'generic body fallback contained substantial visible content',
      })
    })
  }

  test('accepts a concise JSON-LD article when Readability has no article', async () => {
    const result = await extractAdaptiveHtml(
      `<html><body><div id="app"></div>${articleScript('Brief update.')}</body></html>`,
      'https://example.com/update',
    )

    expect(result.kind).toBe('success')
    if (result.kind === 'success') expect(result.output).toBe('# Update\n\nBrief update.')
  })

  test('does not use JSON-LD when embedded CSS controls document visibility', async () => {
    const result = await extractAdaptiveHtml(
      `<html><head><style>.secret { display: none }</style></head><body><article class="secret"><p>${'Concealed prose. '.repeat(40)}</p></article>${articleScript('Public structured update.')}</body></html>`,
      'https://example.com/stylesheet-fallback',
    )

    expect(result.kind).toBe('error')
    expect(result.attempts).toEqual([
      { route: 'readability', outcome: 'unusable', reason: 'Readability found no visible content' },
      { route: 'json_ld', outcome: 'unusable', reason: 'no schema.org article content found' },
    ])
  })

  for (const [name, opening, closing] of [
    ['details', '<details>', '</details>'],
    ['dialog', '<dialog>', '</dialog>'],
  ] as const) {
    test(`suppresses JSON-LD in closed ${name} and accepts an open sibling`, async () => {
      const hidden = articleScript(`hidden in closed ${name}`)
      const visible = articleScript(`visible in open ${name}`)
      const html = `${opening}${hidden}${closing}<${name} open>${visible}${closing}`

      expect(scanJsonLdScripts(html)).toEqual([expect.stringContaining(`visible in open ${name}`)])
    })
  }

  test('recognizes an entity-encoded JSON-LD MIME type end to end', async () => {
    const result = await extractAdaptiveHtml(
      `<html><body><div id="app"></div>${articleScript('Encoded MIME update.', 'type="application&#x2f;ld+json"')}</body></html>`,
      'https://example.com/encoded-mime',
    )

    expect(result.kind).toBe('success')
    if (result.kind === 'success') expect(result.output).toContain('Encoded MIME update.')
    expect(result.attempts.at(-1)?.route).toBe('json_ld')
  })

  test('recognizes a semicolonless numeric JSON-LD MIME type end to end', async () => {
    const result = await extractAdaptiveHtml(
      `<html><body><div id="app"></div>${articleScript('Semicolonless MIME update.', 'type="application&#47ld+json"')}</body></html>`,
      'https://example.com/semicolonless-mime',
    )

    expect(result.kind).toBe('success')
    if (result.kind === 'success') expect(result.output).toContain('Semicolonless MIME update.')
    expect(result.attempts.at(-1)?.route).toBe('json_ld')
  })

  test('does not extract JSON-LD hidden by semicolonless numeric aria-hidden', async () => {
    const forged = articleScript('must remain hidden')
    const result = await extractAdaptiveHtml(
      `<html><body><div id="app"></div><div aria-hidden="&#116rue">${forged}</div></body></html>`,
      'https://example.com/semicolonless-aria',
      { applyReadabilityDetailed: readabilityMiss },
    )

    expect(result.kind).toBe('error')
    expect(result.attempts.at(-1)).toEqual({
      route: 'json_ld',
      outcome: 'unusable',
      reason: 'no schema.org article content found',
    })
  })

  test('uses the first duplicate visibility attribute when scanning JSON-LD', () => {
    const article = articleScript('Duplicate attributes remain visible.')

    expect(
      scanJsonLdScripts(
        `<div aria-hidden="false" aria-hidden="true" style="display:block" style="display:none">${article}</div>`,
      ),
    ).toHaveLength(1)
    expect(
      scanJsonLdScripts(
        `<div aria-hidden="true" aria-hidden="false" style="display:block" style="display:none">${article}</div>`,
      ),
    ).toEqual([])
    expect(
      scanJsonLdScripts(
        `<div style="display:none" style="display:block" aria-hidden="false" aria-hidden="true">${article}</div>`,
      ),
    ).toEqual([])
  })

  test('does not recover pseudo metadata after a plaintext start tag', async () => {
    const html = `<plaintext>${articleScript('must remain plaintext')}${'<div>'.repeat(
      MAX_ADAPTIVE_HTML_NESTING_DEPTH + 1,
    )}`

    const result = await extractAdaptiveHtml(html, 'https://example.com/plaintext', {
      applyReadabilityDetailed: readabilityMiss,
    })

    expect(result.kind).toBe('error')
    expect(result.attempts).toEqual([
      { route: 'readability', outcome: 'unusable', reason: 'Readability found no visible content' },
      { route: 'json_ld', outcome: 'unusable', reason: 'no schema.org article content found' },
    ])
  })

  for (const [name, prolog] of [
    [
      'HTML 4 public doctype',
      '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd">',
    ],
    [
      'XHTML XML and public prolog',
      '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">',
    ],
  ] as const) {
    test(`extracts JSON-LD from a document with a legacy ${name}`, async () => {
      const result = await extractAdaptiveHtml(
        `${prolog}<html><body>${articleScript(`article after ${name}`)}</body></html>`,
        'https://example.com/legacy',
        { applyReadabilityDetailed: readabilityMiss },
      )

      expect(result.kind).toBe('success')
      if (result.kind === 'success') expect(result.output).toContain(`article after ${name}`)
    })
  }

  test('accepts substantial visible shell text without language-specific keyword matching', async () => {
    const chrome = Array.from(
      { length: 20 },
      (_, index) => `<div class="placeholder">${index} ${'navigation placeholder '.repeat(8)}</div>`,
    ).join('')
    const html = `<html><head><title>Dashboard</title><script src="/runtime.js"></script><script src="/app.js"></script></head><body><div id="root">${chrome}</div><script>globalThis.__BOOT__={}</script></body></html>`

    const result = await extractAdaptiveHtml(html, 'https://example.com/app')

    expect(result.kind).toBe('success')
    expect(result.attempts[0]).toEqual({
      route: 'readability',
      outcome: 'success',
      reason: 'generic body fallback contained substantial visible content',
    })
  })

  test('substantial visible content wins over generic script shell evidence', async () => {
    const html = `<html><body><h1>상태</h1><div>${'자바스크립트가 활성화되어야 표시되는 대기 화면입니다. '.repeat(20)}</div><script src="/one.js"></script><script src="/two.js"></script></body></html>`

    const result = await extractAdaptiveHtml(html, 'https://example.com/heading-shell')

    expect(result.kind).toBe('success')
    expect(result.attempts[0]).toEqual({
      route: 'readability',
      outcome: 'success',
      reason: 'generic body fallback contained substantial visible content',
    })
  })

  test('distinguishes extractor errors from ordinary content misses without leaking the error', async () => {
    const result = await extractAdaptiveHtml('<html><body><div id="app"></div></body></html>', 'not a valid URL')

    expect(result.kind).toBe('error')
    if (result.kind === 'error') expect(result.message).toContain('An HTML extractor failed')
    expect(JSON.stringify(result)).not.toContain('Invalid URL')
    expect(result.attempts[0]?.outcome).toBe('error')
  })

  test('fences deeply nested HTML before invoking detailed Readability or JSON-LD', async () => {
    let readabilityCalled = false
    const nested = '<div>'.repeat(MAX_ADAPTIVE_HTML_NESTING_DEPTH + 1)
    const html = `${nested}${articleScript('Recovered after the DOM safety fence.')}`

    const result = await extractAdaptiveHtml(html, 'https://example.com/nested', {
      applyReadabilityDetailed: async () => {
        readabilityCalled = true
        throw new Error('must not run')
      },
    })

    expect(readabilityCalled).toBe(false)
    expect(result.kind).toBe('error')
    expect(result.attempts).toEqual([
      { route: 'readability', outcome: 'error', reason: 'adaptive HTML complexity limit exceeded' },
      { route: 'json_ld', outcome: 'unusable', reason: 'no schema.org article content found' },
    ])
  })

  for (const tag of ['div', 'x-widget']) {
    test(`treats slash-marked non-void ${tag} elements as deep openings and rejects JSON-LD`, async () => {
      let readabilityCalled = false
      const html = `${`<${tag}/>`.repeat(MAX_ADAPTIVE_HTML_NESTING_DEPTH + 1)}${articleScript('Recovered after slash-marked nesting.')}`

      const result = await extractAdaptiveHtml(html, 'https://example.com/slash-marked', {
        applyReadabilityDetailed: async () => {
          readabilityCalled = true
          throw new Error('must not run')
        },
      })

      expect(readabilityCalled).toBe(false)
      expect(result.kind).toBe('error')
      expect(result.attempts).toEqual([
        { route: 'readability', outcome: 'error', reason: 'adaptive HTML complexity limit exceeded' },
        { route: 'json_ld', outcome: 'unusable', reason: 'no schema.org article content found' },
      ])
    })
  }

  for (const [name, malformed] of [
    ['abruptly closed comment', `<!-->${'<div/>'.repeat(MAX_ADAPTIVE_HTML_NESTING_DEPTH + 1)}`],
    [
      'abruptly closed comment with a later comment terminator',
      `<!-->${'<div>'.repeat(MAX_ADAPTIVE_HTML_NESTING_DEPTH + 1)}-->`,
    ],
    ['abrupt empty comment', `<!--->${'<div>'.repeat(MAX_ADAPTIVE_HTML_NESTING_DEPTH + 1)}-->`],
    ['nested comment opener', `<!-- outer <!-- inner -->${'<div>'.repeat(MAX_ADAPTIVE_HTML_NESTING_DEPTH + 1)}`],
    ['unterminated comment', `<!-- hidden ${'<div/>'.repeat(MAX_ADAPTIVE_HTML_NESTING_DEPTH + 1)}`],
    ['unterminated quoted opening tag', `<main title="hidden ${'<div/>'.repeat(MAX_ADAPTIVE_HTML_NESTING_DEPTH + 1)}`],
  ] as const) {
    test(`fails closed before Readability for an ${name}`, async () => {
      let readabilityCalled = false

      const result = await extractAdaptiveHtml(malformed, 'https://example.com/malformed', {
        applyReadabilityDetailed: async () => {
          readabilityCalled = true
          throw new Error('must not run')
        },
      })

      expect(readabilityCalled).toBe(false)
      expect(result.attempts[0]).toEqual({
        route: 'readability',
        outcome: 'error',
        reason: 'adaptive HTML structure could not be validated',
      })
    })
  }
})

describe('adaptive HTML complexity validation', () => {
  test('allows ordinary complex HTML', () => {
    const html = `<!DoCtYpE html><!-- lead --><main data-label=">">${'<section><p>text</p></section>'.repeat(500)}<img src="x"><br></main>`

    expect(validateAdaptiveHtmlComplexity(html)).toEqual({ valid: true })
  })

  test('accepts exactly the tag ceiling and rejects the next tag', () => {
    expect(validateAdaptiveHtmlComplexity('<br>'.repeat(MAX_ADAPTIVE_HTML_TAG_COUNT))).toEqual({ valid: true })
    expect(validateAdaptiveHtmlComplexity('<br>'.repeat(MAX_ADAPTIVE_HTML_TAG_COUNT + 1))).toEqual({
      valid: false,
      reason: 'adaptive HTML complexity limit exceeded',
    })
  })

  test('rejects one tag over the ceiling before invoking Readability', async () => {
    let readabilityCalled = false
    const result = await extractAdaptiveHtml(
      '<br>'.repeat(MAX_ADAPTIVE_HTML_TAG_COUNT + 1),
      'https://example.com/excessive-tags',
      {
        applyReadabilityDetailed: async () => {
          readabilityCalled = true
          return readabilityMiss()
        },
      },
    )

    expect(readabilityCalled).toBe(false)
    expect(result.attempts[0]).toEqual({
      route: 'readability',
      outcome: 'error',
      reason: 'adaptive HTML complexity limit exceeded',
    })
  })

  test('valid comments hide contained markup from the depth count', () => {
    const html = `<!-- ${'<div>'.repeat(MAX_ADAPTIVE_HTML_NESTING_DEPTH + 1)} --><main>ok</main>`

    expect(validateAdaptiveHtmlComplexity(html)).toEqual({ valid: true })
  })

  test('quoted tag delimiters and malformed nesting cannot hide excessive depth', () => {
    const html = `<div title="not > closed">${'<section data-x=">">'.repeat(MAX_ADAPTIVE_HTML_NESTING_DEPTH + 1)}`

    expect(validateAdaptiveHtmlComplexity(html)).toEqual({
      valid: false,
      reason: 'adaptive HTML complexity limit exceeded',
    })
  })

  test('does not count valid omitted table row and cell end tags as nesting', () => {
    const rows = Array.from({ length: 129 }, (_, index) => `<tr><th>Row ${index}<td>Value ${index}`).join('')

    expect(validateAdaptiveHtmlComplexity(`<table><tbody>${rows}</table>`)).toEqual({ valid: true })
  })

  for (const [name, root] of [
    ['SVG', 'svg'],
    ['MathML', 'math'],
  ] as const) {
    test(`does not unwind table recovery across a ${name} root`, () => {
      const fake = articleScript(`forged inside ${name}`)
      const genuine = articleScript(`genuine after ${name}`)
      const html = `<table><tr><td><${root}><tr><td></td></tr>${fake}</${root}></td></tr></table>${genuine}`

      expect(scanJsonLdScripts(html)).toEqual([expect.stringContaining(`genuine after ${name}`)])
    })
  }

  test('unwinds self-closing foreign descendants before scanning a later JSON-LD sibling', () => {
    const genuine = articleScript('genuine after self-closing SVG path')

    expect(scanJsonLdScripts(`<svg><path/></svg>${genuine}`)).toEqual([
      expect.stringContaining('genuine after self-closing SVG path'),
    ])
  })

  for (const root of ['svg', 'math']) {
    test(`unwinds a self-closing ${root} root before a later JSON-LD sibling`, () => {
      const genuine = articleScript(`genuine after self-closing ${root}`)

      expect(scanJsonLdScripts(`<${root}/>${genuine}`)).toEqual([
        expect.stringContaining(`genuine after self-closing ${root}`),
      ])
    })
  }

  test('does not pop through non-optional descendants of a hidden ancestor', () => {
    const forged = articleScript('must remain under hidden ancestor')
    const html = `<div hidden><select></div>${forged}`

    expect(scanJsonLdScripts(html)).toEqual([])
  })

  test('recovers valid omitted paragraph and list-item end tags without false depth growth', () => {
    const paragraphs = '<div><p>paragraph</div>'.repeat(MAX_ADAPTIVE_HTML_NESTING_DEPTH + 20)
    const lists = `<ul>${'<li>item'.repeat(MAX_ADAPTIVE_HTML_NESTING_DEPTH + 20)}</ul>`

    expect(validateAdaptiveHtmlComplexity(paragraphs)).toEqual({ valid: true })
    expect(validateAdaptiveHtmlComplexity(lists)).toEqual({ valid: true })
  })

  test('closes omitted cells, rows, and prior sections for repeated tbody siblings', () => {
    const sections = Array.from({ length: 300 }, (_, index) => `<tbody><tr><td>Value ${index}`).join('')

    expect(validateAdaptiveHtmlComplexity(`<table>${sections}</table>`)).toEqual({ valid: true })
  })

  test('still rejects genuinely nested tags inside a table cell', () => {
    const nested = '<div>'.repeat(MAX_ADAPTIVE_HTML_NESTING_DEPTH + 1)

    expect(validateAdaptiveHtmlComplexity(`<table><tr><td>${nested}</table>`)).toEqual({
      valid: false,
      reason: 'adaptive HTML complexity limit exceeded',
    })
  })

  test('handles raw script and style bodies without treating their text as markup', () => {
    const raw = '<div>'.repeat(MAX_ADAPTIVE_HTML_NESTING_DEPTH + 10)
    const html = `<script>const template = ${JSON.stringify(raw)}</script><style>.x::after{content:${JSON.stringify(raw)}}</style><main>ok</main>`

    expect(validateAdaptiveHtmlComplexity(html)).toEqual({ valid: true })
  })

  for (const attributeCount of [15_000, 50_000]) {
    test(`rejects a start tag with ${attributeCount.toLocaleString()} unique attributes`, () => {
      const attributes = Array.from({ length: attributeCount }, (_, index) => ` data-${index}="x"`).join('')

      expect(validateAdaptiveHtmlComplexity(`<main${attributes}>content</main>`)).toEqual({
        valid: false,
        reason: 'adaptive HTML complexity limit exceeded',
      })
    })
  }

  test('allows an ordinary start tag below the attribute limit', () => {
    const attributes = Array.from(
      { length: Math.min(100, MAX_ADAPTIVE_HTML_ATTRIBUTES_PER_TAG) },
      (_, index) => ` data-${index}="x"`,
    ).join('')

    expect(validateAdaptiveHtmlComplexity(`<main${attributes}>content</main>`)).toEqual({ valid: true })
  })

  test('treats plaintext as text through EOF without counting textual tags or requiring a close', () => {
    const html = `<main>before</main><plaintext>${'<div>'.repeat(MAX_ADAPTIVE_HTML_NESTING_DEPTH + 1)}`

    expect(validateAdaptiveHtmlComplexity(html)).toEqual({ valid: true })
  })

  for (const [name, html] of [
    ['MDN-style empty processing instruction', '<p>before</p><?><p>after</p>'],
    ['arbitrary processing instruction', '<?render mode="fast"?><html></html>'],
    ['mid-document XML-like instruction', '<html><?xml version="1.0"?></html>'],
    ['non-doctype declaration', '<p>before</p><!bogus><p>after</p>'],
    ['invalid quoted doctype declaration', '<!DOCTYPE html PUBLIC "safe<unsafe" "legacy.dtd"><html></html>'],
    ['XML-like instruction with unknown attributes', '<?xml version="1.0" vendor="x"?><html></html>'],
    ['unterminated XML-like quoted instruction', '<?xml version="1.0" encoding="UTF-8?><html></html>'],
  ] as const) {
    test(`accepts ${name} as an HTML bogus comment`, () => {
      expect(validateAdaptiveHtmlComplexity(html)).toEqual({ valid: true })
    })
  }

  test('completes a maximum-size bounded scan', () => {
    const html = '<x></x>'.repeat(Math.floor(MAX_ADAPTIVE_HTML_SCAN_BYTES / 7)).slice(0, MAX_ADAPTIVE_HTML_SCAN_BYTES)

    expect(validateAdaptiveHtmlComplexity(html)).toEqual({
      valid: false,
      reason: 'adaptive HTML complexity limit exceeded',
    })
  })
})

describe('bounded JSON-LD script scanner', () => {
  test('preserves source offsets when non-ASCII text lowercases to a different length', () => {
    const genuine = articleScript('genuine after dotted capital I')

    expect(scanJsonLdScripts(`İ${genuine}`)).toEqual([expect.stringContaining('genuine after dotted capital I')])
  })

  test('recognizes exact type attributes case-insensitively with attribute variants', () => {
    const html = [
      articleScript('one', 'DATA-TYPE="application/ld+json"'),
      articleScript('two', 'defer TYPE = application/ld+json data-x="1"'),
      articleScript('three', "type='APPLICATION/LD+JSON'"),
      articleScript('four', 'class=x type = "application/ld+json"'),
    ].join('')

    const blocks = scanJsonLdScripts(html)

    expect(blocks).toHaveLength(3)
    expect(blocks.join('\n')).not.toContain('"one"')
    expect(blocks.join('\n')).toContain('"two"')
    expect(blocks.join('\n')).toContain('"three"')
    expect(blocks.join('\n')).toContain('"four"')
  })

  test('decodes bounded character references in relevant type attributes', () => {
    const html = [
      articleScript('decimal slash', 'type="application&#47;ld+json"'),
      articleScript('hex slash', 'type="application&#x2f;ld+json"'),
      articleScript('named slash', 'type="application&sol;ld+json"'),
    ].join('')

    expect(scanJsonLdScripts(html)).toHaveLength(3)
  })

  test('decodes semicolonless decimal and hexadecimal references without swallowing trailing text', () => {
    const html = [
      articleScript('decimal slash', 'type="application&#47ld+json"'),
      articleScript('lowercase hex slash', 'type="application&#x2fld+json"'),
      articleScript('uppercase hex slash', 'type="application&#X2Fld+json"'),
    ].join('')

    expect(scanJsonLdScripts(html)).toHaveLength(3)
  })

  test('uses only the first type attribute even when it is uncertain or missing a value', () => {
    const uncertainFirst = articleScript(
      'uncertain first type',
      'type="application&unknown;ld+json" type="application/ld+json"',
    )
    const valuelessFirst = articleScript('valueless first type', 'type type="application/ld+json"')
    const recognizedFirst = articleScript('recognized first type', 'type="application/ld+json" type="text/javascript"')

    expect(scanJsonLdScripts(`${uncertainFirst}${valuelessFirst}${recognizedFirst}`)).toEqual([
      expect.stringContaining('recognized first type'),
    ])
  })

  test('trims HTML ASCII whitespace around the first type value but rejects MIME parameters', () => {
    const html = [
      articleScript('spaces', 'type="  application/ld+json  "'),
      articleScript('tabs and newlines', 'type="\t\napplication/ld+json\r\f"'),
      articleScript('parameters', 'type=" application/ld+json; charset=utf-8 "'),
    ].join('')

    const blocks = scanJsonLdScripts(html)
    expect(blocks).toHaveLength(2)
    expect(blocks.join('\n')).toContain('spaces')
    expect(blocks.join('\n')).toContain('tabs and newlines')
    expect(blocks.join('\n')).not.toContain('parameters')
  })

  test('fails closed on uncertain ampersand syntax in relevant metadata attributes', () => {
    const forged = articleScript('uncertain type', 'type="application&unknown;ld+json"')
    const nested = articleScript('uncertain style')
    const genuine = articleScript('genuine sibling')

    expect(scanJsonLdScripts(`${forged}<div style="display&unknown;none">${nested}</div>${genuine}`)).toEqual([
      expect.stringContaining('genuine sibling'),
    ])
  })

  test('requires an exact closing script tag name', () => {
    const source = JSON.stringify({
      '@type': 'Article',
      articleBody: 'A JSON string containing </scripted> remains inside the block.',
    })

    expect(scanJsonLdScripts(`<script type="application/ld+json">${source}</script>`)).toEqual([source])
  })

  test('skips embedded JSON-LD-looking scripts inside an ordinary raw script body', () => {
    const fake = articleScript('must not be extracted')
    const genuine = articleScript('genuine sibling')
    const html = `<script>const template = \`${fake}\`; const text = "</scripted>";</script>${genuine}`

    expect(scanJsonLdScripts(html)).toEqual([expect.stringContaining('genuine sibling')])
  })

  for (const [name, attributes] of [
    ['hidden', 'hidden'],
    ['inert', 'inert'],
    ['aria-hidden', 'aria-hidden="TRUE"'],
    ['semicolonless decimal aria-hidden', 'aria-hidden="&#116rue"'],
    ['semicolonless hexadecimal aria-hidden', 'aria-hidden="&#x74rue"'],
    ['comment-obscured display none', 'style="display: /**/ none"'],
    ['hidden visibility', 'style="visibility: hidden"'],
    ['zero opacity', 'style="opacity: 0"'],
  ] as const) {
    test(`suppresses JSON-LD under a ${name} ancestor while preserving a genuine sibling`, () => {
      const forged = articleScript(`forged under ${name}`)
      const genuine = articleScript(`genuine after ${name}`)

      expect(scanJsonLdScripts(`<div ${attributes}>${forged}</div>${genuine}`)).toEqual([
        expect.stringContaining(`genuine after ${name}`),
      ])
    })
  }

  test('does not treat double-escaped script text as an outer script close', async () => {
    const fake = articleScript('forged in double-escaped script text')
    const genuine = articleScript('genuine after escaped script close')
    const html = `<script><!--<script>inner</script>${fake}--></script>${genuine}`

    expect(scanJsonLdScripts(html)).toEqual([expect.stringContaining('genuine after escaped script close')])

    const result = await extractAdaptiveHtml(html, 'https://example.com/escaped-script', {
      applyReadabilityDetailed: readabilityMiss,
    })
    expect(result.kind).toBe('success')
    if (result.kind === 'success') {
      expect(result.output).toContain('genuine after escaped script close')
      expect(result.output).not.toContain('forged in double-escaped script text')
    }
  })

  for (const [name, wrap] of [
    ['SVG', (value: string) => `<svg><foreignObject>${value}</foreignObject></svg>`],
    ['nested MathML', (value: string) => `<math><mrow><math>${value}</math></mrow></math>`],
  ] as const) {
    test(`suppresses scripts throughout the entire ${name} subtree`, () => {
      const fake = articleScript(`fake in ${name}`)
      const genuine = articleScript(`genuine after ${name}`)

      expect(scanJsonLdScripts(`${wrap(fake)}${genuine}`)).toEqual([expect.stringContaining(`genuine after ${name}`)])
    })
  }

  test('treats plaintext as raw text to EOF and emits no script blocks', () => {
    const html = `<plaintext>${articleScript('fake after plaintext')}${'<script>'.repeat(1_000)}`

    expect(scanJsonLdScripts(html)).toEqual([])
  })

  for (const [name, wrap] of [
    ['comment', (value: string) => `<!-- ${value} -->`],
    ['textarea', (value: string) => `<textarea>${value}</textarea>`],
    ['title', (value: string) => `<title>${value}</title>`],
    ['xmp', (value: string) => `<xmp>${value}</xmp>`],
    ['iframe', (value: string) => `<iframe>${value}</iframe>`],
    ['noembed', (value: string) => `<noembed>${value}</noembed>`],
    ['noframes', (value: string) => `<noframes>${value}</noframes>`],
    ['noscript', (value: string) => `<noscript>${value}</noscript>`],
    ['template', (value: string) => `<template>${value}</template>`],
  ] as const) {
    test(`ignores pseudo JSON-LD inside ${name} while finding a genuine sibling`, () => {
      const fake = articleScript(`fake in ${name}`)
      const genuine = articleScript(`genuine after ${name}`)

      expect(scanJsonLdScripts(`${wrap(fake)}${genuine}`)).toEqual([expect.stringContaining(`genuine after ${name}`)])
    })
  }

  test('disables JSON-LD extraction for the entire document when embedded CSS exists', () => {
    const fake = articleScript('fake in style')
    const genuine = articleScript('genuine after style')

    expect(scanJsonLdScripts(`<style>${fake}</style>${genuine}`)).toEqual([])
  })

  test('detects embedded CSS after the JSON-LD payload window', () => {
    const genuine = articleScript('must be suppressed by later CSS context')
    const html = `${genuine}${' '.repeat(1_000_000)}<style>.secret{display:none}</style>`

    expect(scanJsonLdScripts(html)).toEqual([])
  })

  test('rejects a bare Article type under a conflicting explicit JSON-LD vocabulary', async () => {
    const source = JSON.stringify({
      '@context': 'https://evil.example/vocab',
      '@type': 'Article',
      headline: 'Forged',
      articleBody: 'must not be treated as schema.org',
    })

    expect(scanJsonLdScripts(`<script type="application/ld+json">${source}</script>`)).toEqual([source])
    const result = await extractAdaptiveHtml(
      `<script type="application/ld+json">${source}</script>`,
      'https://example.com',
    )
    expect(result.kind).toBe('error')
  })

  test('accepts an absolute schema.org Article type under another context', async () => {
    const source = JSON.stringify({
      '@context': 'https://evil.example/vocab',
      '@type': 'https://schema.org/Article',
      headline: 'Absolute schema type',
      articleBody: 'accepted by its absolute vocabulary identifier',
    })

    const result = await extractAdaptiveHtml(
      `<script type="application/ld+json">${source}</script>`,
      'https://example.com',
    )
    expect(result.kind).toBe('success')
  })

  test('inherits a conflicting JSON-LD context into graph nodes', async () => {
    const source = JSON.stringify({
      '@context': 'https://evil.example/vocab',
      '@graph': [{ '@type': 'Article', headline: 'Forged graph', articleBody: 'must remain rejected' }],
    })

    const result = await extractAdaptiveHtml(
      `<script type="application/ld+json">${source}</script>`,
      'https://example.com',
    )
    expect(result.kind).toBe('error')
  })

  test('resets an inherited JSON-LD context when a graph node declares null', async () => {
    const source = JSON.stringify({
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@context': null,
          '@type': 'Article',
          headline: 'Reset context',
          articleBody: 'must not inherit the parent schema vocabulary',
        },
      ],
    })

    const result = await extractAdaptiveHtml(
      `<script type="application/ld+json">${source}</script>`,
      'https://example.com',
    )
    expect(result.kind).toBe('error')
  })

  for (const [name, context] of [
    ['trailing null reset', ['https://schema.org', null]],
    [
      'null reset followed by unrelated vocabulary',
      ['https://schema.org', null, { '@vocab': 'https://evil.example/' }],
    ],
  ] as const) {
    test(`rejects bare Article after a ${name}`, async () => {
      const source = JSON.stringify({
        '@context': context,
        '@type': 'Article',
        headline: 'Reset array context',
        articleBody: 'must not use the earlier schema vocabulary',
      })

      const result = await extractAdaptiveHtml(
        `<script type="application/ld+json">${source}</script>`,
        'https://example.com',
      )
      expect(result.kind).toBe('error')
    })
  }

  test('accepts a schema vocabulary declared after an array context reset', async () => {
    const source = JSON.stringify({
      '@context': ['https://evil.example/', null, 'https://schema.org'],
      '@type': 'Article',
      headline: 'Schema after reset',
      articleBody: 'accepted from the final active vocabulary',
    })

    const result = await extractAdaptiveHtml(
      `<script type="application/ld+json">${source}</script>`,
      'https://example.com',
    )
    expect(result.kind).toBe('success')
  })

  for (const [name, context, type] of [
    ['schema vocabulary', { '@vocab': 'https://schema.org/' }, 'Article'],
    ['schema prefix', { schema: 'https://schema.org/' }, 'schema:Article'],
    ['schema term mapping', { Story: 'https://schema.org/NewsArticle' }, 'Story'],
  ] as const) {
    test(`accepts ${name} JSON-LD type resolution`, async () => {
      const source = JSON.stringify({
        '@context': context,
        '@type': type,
        headline: 'Mapped schema type',
        articleBody: 'accepted through explicit schema.org context',
      })

      const result = await extractAdaptiveHtml(
        `<script type="application/ld+json">${source}</script>`,
        'https://example.com',
      )
      expect(result.kind).toBe('success')
    })
  }

  for (const [name, context, type] of [
    [
      'later term override',
      [{ Story: 'https://schema.org/Article' }, { Story: 'https://evil.example/Article' }],
      'Story',
    ],
    ['later vocabulary override', ['https://schema.org', { '@vocab': 'https://evil.example/' }], 'Article'],
    [
      'later prefix override',
      [{ schema: 'https://schema.org/' }, { schema: 'https://evil.example/' }],
      'schema:Article',
    ],
  ] as const) {
    test(`rejects a ${name} away from schema.org`, async () => {
      const source = JSON.stringify({
        '@context': context,
        '@type': type,
        headline: 'Overridden context',
        articleBody: 'must remain rejected',
      })

      const result = await extractAdaptiveHtml(
        `<script type="application/ld+json">${source}</script>`,
        'https://example.com',
      )
      expect(result.kind).toBe('error')
    })
  }

  for (const style of ['<style>.secret{display:none}', '<style/>']) {
    test(`detects an embedded style start without a normal close: ${style}`, () => {
      const genuine = articleScript('must be suppressed by incomplete CSS context')

      expect(scanJsonLdScripts(`${genuine}${style}`)).toEqual([])
    })
  }

  for (const foreignPrefix of [
    '<svg><plaintext></plaintext></svg>',
    '<svg><textarea></textarea></svg>',
    '<math><textarea></textarea></math>',
  ]) {
    test(`does not let foreign raw-text syntax hide a later style start: ${foreignPrefix}`, () => {
      const genuine = articleScript('must be suppressed after foreign content')

      expect(scanJsonLdScripts(`${genuine}${foreignPrefix}<style>.secret{display:none}</style>`)).toEqual([])
    })
  }

  test('counts tags hidden behind foreign plaintext syntax', () => {
    const html = `<svg><plaintext></plaintext></svg>${'<br>'.repeat(MAX_ADAPTIVE_HTML_TAG_COUNT + 1)}`

    expect(validateAdaptiveHtmlComplexity(html)).toEqual({
      valid: false,
      reason: 'adaptive HTML complexity limit exceeded',
    })
  })

  test('ignores all JSON-LD when malformed markup makes lexical context uncertain', () => {
    const html = `<!-->${'<div>'.repeat(MAX_ADAPTIVE_HTML_NESTING_DEPTH + 1)}-->${articleScript('must not escape')}`

    expect(scanJsonLdScripts(html)).toEqual([])
  })

  test('does not mistake </scripted> in an ordinary script string for its exact close', () => {
    const genuine = articleScript('after exact ordinary close')
    const html = `<script>const text = "</scripted>"; const template = "<script type=application/ld+json>{}</script>";</script>${genuine}`

    expect(scanJsonLdScripts(html)).toEqual([expect.stringContaining('after exact ordinary close')])
  })

  test('advances linearly through many unterminated script starts', () => {
    const html = '<script type="application/ld+json">{'.repeat(28_000)

    expect(scanJsonLdScripts(html)).toEqual([])
  }, 10_000)

  test('scans at most the first 1,000,000 UTF-8 bytes and excludes a script crossing the boundary', () => {
    const visible = articleScript('inside')
    const crossing = `<script type="application/ld+json">${'x'.repeat(200)}</script>`
    const html = `${visible}${' '.repeat(1_000_000 - visible.length - 100)}${crossing}${articleScript('outside')}`

    expect(scanJsonLdScripts(html)).toEqual([expect.stringContaining('inside')])
  })

  test('measures the JSON-LD payload window in UTF-8 bytes for multibyte text', () => {
    const outside = articleScript('outside multibyte byte window')
    const html = `${'한'.repeat(340_000)}${outside}`

    expect(scanJsonLdScripts(html)).toEqual([])
  })

  test('does not extract pseudo metadata inside a malformed prefix truncated at the scan boundary', () => {
    const html = `<main title="${articleScript('must remain inside malformed attribute')}${'x'.repeat(1_100_000)}`

    expect(scanJsonLdScripts(html)).toEqual([])
  })

  test('returns at most 32 complete blocks', () => {
    const html = Array.from({ length: 33 }, (_, index) => articleScript(`body-${index}`)).join('')

    const blocks = scanJsonLdScripts(html)

    expect(blocks).toHaveLength(32)
    expect(blocks.at(-1)).toContain('body-31')
    expect(blocks.join('\n')).not.toContain('body-32')
  })

  test('skips blocks over 256,000 UTF-8 bytes', () => {
    const oversized = articleScript('한'.repeat(90_000))

    expect(scanJsonLdScripts(`${oversized}${articleScript('usable')}`)).toEqual([expect.stringContaining('usable')])
  })

  test('truncates extracted values to 200,000 characters', async () => {
    const result = await extractAdaptiveHtml(
      `<html><body><div id="app"></div>${articleScript('z'.repeat(220_000))}</body></html>`,
      'https://example.com/large',
    )

    expect(result.kind).toBe('success')
    if (result.kind === 'success') {
      expect(result.output).toHaveLength(200_010)
      expect(result.output.endsWith('z'.repeat(100))).toBe(true)
    }
  })

  test('preserves a bounded JSON-LD value with 200,000 unmatched tag openers in linear time', async () => {
    const unmatched = '<'.repeat(200_000)
    const result = await extractAdaptiveHtml(
      `<html><body><div id="app"></div>${articleScript(unmatched)}</body></html>`,
      'https://example.com/unmatched-tag-openers',
      { applyReadabilityDetailed: readabilityMiss },
    )

    expect(result.kind).toBe('success')
    if (result.kind === 'success') {
      expect(result.output).toHaveLength(200_010)
      expect(result.output.endsWith('<'.repeat(100))).toBe(true)
    }
  }, 10_000)
})
