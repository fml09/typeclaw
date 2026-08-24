import { describe, expect, test } from 'bun:test'

import { VISIBILITY_PROPERTIES } from '../inline-style-visibility'
import {
  applyReadability,
  applyReadabilityDetailed,
  buildComputedStyleResolver,
  pruneHiddenContent,
  reduceToVisibilityDeclarations,
} from './readability'

const ARTICLE = `
<!doctype html>
<html lang="en"><head><title>The Sample Article</title></head><body>
  <header><nav><a href="/">Home</a></nav></header>
  <article>
    <h1>The Sample Article</h1>
    <p>This is a paragraph of body text that is long enough for Readability to consider it main content. Readability heuristics generally need substantive prose to score an article highly.</p>
    <p>Here is a second paragraph that adds to the article body so the heuristics fire reliably across versions of @mozilla/readability.</p>
    <h2>Section</h2>
    <p>More body content with <a href="https://example.com/x">an example link</a> embedded inline.</p>
    <ul><li>First</li><li>Second</li></ul>
  </article>
  <footer>copyright</footer>
</body></html>`

describe('applyReadability', () => {
  test('extracts the article body and renders markdown headings, paragraphs, and lists', async () => {
    const result = await applyReadability(ARTICLE, 'https://example.com/post')

    expect(result).toMatch(/^# The Sample Article/)
    expect(result).toContain('paragraph of body text')
    expect(result).toContain('## Section')
    expect(result).toMatch(/-\s+First/)
    expect(result).toMatch(/-\s+Second/)
    expect(result).toContain('[an example link](https://example.com/x)')
  })

  test('does not include navigation or footer chrome', async () => {
    const result = await applyReadability(ARTICLE, 'https://example.com/post')
    expect(result).not.toContain('Home')
    expect(result).not.toContain('copyright')
  })

  test('returns a clear message when there is nothing to extract', async () => {
    const result = await applyReadability('<html><body></body></html>', 'https://example.com/empty')
    expect(result).toBe('Readability extracted no content from this page.')
  })

  test('reports whether output came from a parsed article or generic body fallback', async () => {
    const article = await applyReadabilityDetailed(ARTICLE, 'https://example.com/post')
    const fallback = await applyReadabilityDetailed(
      '<html><body><div id="root">Application placeholder</div><script src="/app.js"></script></body></html>',
      'https://example.com/app',
    )

    expect(article.parsedArticle).toBe(true)
    expect(article.usedBodyFallback).toBe(false)
    expect(article.hasSemanticContentContainer).toBe(true)
    expect(fallback.parsedArticle).toBe(true)
    expect(fallback.hasSemanticContentContainer).toBe(false)
    expect(fallback.proseElementCount).toBe(0)
    expect(fallback.structuredContentElementCount).toBe(0)
    expect(fallback.scriptCount).toBe(1)
    expect(fallback.visibleTextCharacterCount).toBe('Application placeholder'.length)
  })

  test('excludes script and hidden content from visible text evidence', async () => {
    const result = await applyReadabilityDetailed(
      `<html><head><title>${'hidden'.repeat(100)}</title></head><body><div>Loading</div><script>${'x'.repeat(800)}</script><template>${'z'.repeat(800)}</template><noscript>${'n'.repeat(800)}</noscript><noframes>${'f'.repeat(800)}</noframes><div hidden>${'h'.repeat(800)}</div><div aria-hidden="true">${'a'.repeat(800)}</div><div style="display: none">${'d'.repeat(800)}</div><div style="visibility:hidden">${'v'.repeat(800)}</div></body></html>`,
      'https://example.com/loading',
    )

    expect(result.visibleTextCharacterCount).toBe('Loading'.length)
  })

  test('prunes hidden structure before collecting evidence or parsing with Readability', async () => {
    const hiddenArticle = 'Forged hidden article body with enough prose to satisfy extraction. '.repeat(12)
    const result = await applyReadabilityDetailed(
      `<html><body><div>Loading</div><article hidden><h1>Forged</h1><p>${hiddenArticle}</p></article><main aria-hidden="true"><p>${hiddenArticle}</p></main><p aria-hidden="true">${hiddenArticle}</p><p style="display:/**/ none">${hiddenArticle}</p><p style="visibility: collapse">${hiddenArticle}</p><p style="opacity: 0">${hiddenArticle}</p><p style="position:absolute;left:-10000px">${hiddenArticle}</p><input type="hidden" value="forged"><script hidden src="/hidden.js"></script><script src="/visible.js"></script></body></html>`,
      'https://example.com/hidden',
    )

    expect(result.output).not.toContain('Forged hidden article')
    expect(result.hasSemanticContentContainer).toBe(false)
    expect(result.hasArticleContainer).toBe(false)
    expect(result.proseElementCount).toBe(0)
    expect(result.scriptCount).toBe(1)
    expect(result.visibleTextCharacterCount).toBe('Loading'.length)
  })

  test('prunes content hidden by an embedded stylesheet while preserving visible prose', async () => {
    const concealed = 'Concealed stylesheet-controlled article. '.repeat(40)
    const visible = 'Visible article alongside an embedded stylesheet. '.repeat(40)
    const result = await applyReadabilityDetailed(
      `<html><head><style>.secret { display: none }</style></head><body><article class="secret"><h1>Hidden</h1><p>${concealed}</p></article><article><h1>Visible</h1><p>${visible}</p></article></body></html>`,
      'https://example.com/embedded-stylesheet',
    )

    expect(result.output).toContain('Visible article alongside an embedded stylesheet')
    expect(result.output).not.toContain('Concealed stylesheet-controlled article')
  })

  test('rejects embedded stylesheets whose rule-to-element work exceeds the budget', async () => {
    const rules = Array.from({ length: 800 }, (_, index) => `.rule-${index}{display:block}`).join('')
    const elements = '<p>content</p>'.repeat(3_000)

    await expect(
      applyReadability(
        `<html><head><style>${rules}</style></head><body>${elements}</body></html>`,
        'https://example.com/css-budget',
      ),
    ).rejects.toThrow('Embedded stylesheet complexity limit exceeded')
  })

  test('rejects many short selector-list components before JSDOM work exceeds the budget', async () => {
    const selectorList = Array.from({ length: 600 }, () => '.s').join(',')
    const elements = '<i>content</i>'.repeat(3_500)

    await expect(
      applyReadability(
        `<html><head><style>${selectorList}{display:block}</style></head><body>${elements}</body></html>`,
        'https://example.com/selector-list-budget',
      ),
    ).rejects.toThrow('Embedded stylesheet complexity limit exceeded')
  })

  test('accepts selector commas nested in functions, strings, attributes, and escapes', async () => {
    const prose = 'Visible prose selected by ordinary bounded CSS. '.repeat(40)
    const result = await applyReadability(
      String.raw`<html><head><style>:is(.one,.two),[data-label="x,y"],.escaped\,comma{display:block}</style></head><body><article><p>${prose}</p></article></body></html>`,
      'https://example.com/nested-selector-commas',
    )

    expect(result).toContain('Visible prose selected by ordinary bounded CSS')
  })

  test('rejects a single pathological selector before computed-style matching', async () => {
    const selector = '.x'.repeat(2_000)

    await expect(
      applyReadability(
        `<html><head><style>${selector}{display:none}</style></head><body><article><p>content</p></article></body></html>`,
        'https://example.com/selector-budget',
      ),
    ).rejects.toThrow('Embedded stylesheet complexity limit exceeded')
  })

  test('rejects a pathological selector in the raw preflight before JSDOM construction', async () => {
    const selector = '.x'.repeat(40_000)
    const startedAt = performance.now()

    await expect(
      applyReadability(`<style>${selector}{display:none}</style><p>content</p>`, 'https://example.com/raw-selector'),
    ).rejects.toThrow('Embedded stylesheet complexity limit exceeded')
    expect(performance.now() - startedAt).toBeLessThan(500)
  })

  test('preserves source-visible article content when an external stylesheet is not loaded', async () => {
    const visible = 'Source-visible article with an unresolved linked stylesheet. '.repeat(40)
    const result = await applyReadability(
      `<html><head><link rel="stylesheet" href="/site.css"></head><body><article><h1>Visible</h1><p>${visible}</p></article></body></html>`,
      'https://example.com/linked-stylesheet',
    )

    expect(result).toContain('Source-visible article with an unresolved linked stylesheet')
  })

  test('preserves source-visible prose inside an inert article', async () => {
    const prose = 'Source-visible inert article prose remains extractable. '.repeat(40)
    const result = await applyReadability(
      `<html><body><article inert><h1>Reference</h1><p>${prose}</p></article></body></html>`,
      'https://example.com/inert-article',
    )

    expect(result).toContain('Source-visible inert article prose remains extractable')
  })

  test('prunes deterministic native and inline hidden states', async () => {
    const concealed = 'Deterministically concealed article prose. '.repeat(40)
    const visible = 'Genuine visible sibling article prose. '.repeat(40)
    const result = await applyReadabilityDetailed(
      `<html><body><article style="content-visibility:hidden"><p>${concealed}</p></article><dialog><article><p>${concealed}</p></article></dialog><details><summary>Visible summary</summary><article><p>${concealed}</p></article></details><article><h1>Visible</h1><p>${visible}</p></article></body></html>`,
      'https://example.com/native-hidden',
    )

    expect(result.output).toContain('Genuine visible sibling article prose')
    expect(result.output).not.toContain('Deterministically concealed article prose')
    expect(result.visibleTextCharacterCount).toBe(`Visible summaryVisible${visible}`.trim().length)
  })

  for (const opacity of ['-0', '0.0', '.0', '0e0', '0E+10']) {
    test(`prunes content with CSS opacity ${opacity}`, async () => {
      const hidden = 'Hidden opacity content. '.repeat(40)
      const result = await applyReadabilityDetailed(
        `<html><body><div>Loading</div><article style="opacity:${opacity}"><p>${hidden}</p></article></body></html>`,
        'https://example.com/opacity',
      )

      expect(result.output).not.toContain('Hidden opacity content')
      expect(result.hasArticleContainer).toBe(false)
      expect(result.visibleTextCharacterCount).toBe('Loading'.length)
    })
  }

  for (const [name, style] of [
    ['escaped display', String.raw`display:n\6fne`],
    ['escaped visibility', String.raw`visibility:h\69 dden`],
    ['escaped display property', String.raw`d\69splay:none`],
    ['escaped visibility property', String.raw`visib\69lity:hidden`],
    ['escaped opacity property', String.raw`opac\69ty:0`],
    ['nested custom-property semicolons', 'display:none;--x:func(;display:block;)'],
    ['nested custom-property block semicolons', 'display:none;--x:{;display:block;}'],
    ['escaped newline continuation', 'display:no\\\nne'],
    ['negative opacity', 'opacity:-0.1'],
    ['zero percentage opacity', 'opacity:0%'],
    ['calculated zero opacity', 'opacity:calc(0)'],
    ['malformed positive sign opacity', 'opacity:+'],
    ['malformed exponent opacity', 'opacity:0e'],
  ] as const) {
    test(`prunes an article hidden by ${name} and extracts its genuine sibling`, async () => {
      const hidden = `Hidden ${name} article. `.repeat(40)
      const genuine = 'Genuine visible article content with enough prose for extraction. '.repeat(20)
      const result = await applyReadability(
        `<html><body><article style="${style}"><h1>Hidden</h1><p>${hidden}</p></article><article><h1>Genuine</h1><p>${genuine}</p></article></body></html>`,
        'https://example.com/style-parity',
      )

      expect(result).toContain('Genuine visible article')
      expect(result).not.toContain(`Hidden ${name} article`)
    })
  }

  test('keeps a visible article with a harmless custom-property semicolon', async () => {
    const visible = 'Genuine visible article with a harmless custom property. '.repeat(40)
    const result = await applyReadability(
      `<html><body><article style='--label:"x; display:none";display:block'><h1>Visible</h1><p>${visible}</p></article></body></html>`,
      'https://example.com/custom-property',
    )

    expect(result).toContain('Genuine visible article with a harmless custom property')
  })

  test('keeps visible articles with matched blocks, strings, URLs, continuations, and initial values', async () => {
    const visible = 'Genuine article through valid CSS grammar. '.repeat(40)
    const styles = [
      `--tokens:{color:red;nested:[one(two)]};display:block`,
      `--label:"x;display:none";display:block`,
      `background:url("data:image/svg+xml;display:none");display:block`,
      `--label:"continued\\\nvalue";display:block`,
      `display:initial;visibility:initial;opacity:initial`,
    ]

    for (const style of styles) {
      const result = await applyReadability(
        `<html><body><article style='${style}'><h1>Visible</h1><p>${visible}</p></article></body></html>`,
        'https://example.com/valid-css',
      )
      expect(result).toContain('Genuine article through valid CSS grammar')
    }
  })

  test('keeps articles with positive numeric and percentage opacity', async () => {
    for (const opacity of ['0.1', '10%']) {
      const visible = `Visible positive ${opacity} opacity article. `.repeat(40)
      const result = await applyReadability(
        `<html><body><article style="opacity:${opacity}"><h1>Visible</h1><p>${visible}</p></article></body></html>`,
        'https://example.com/positive-opacity',
      )

      expect(result).toContain(`Visible positive ${opacity} opacity article`)
    }
  })

  test('prunes stylesheet-hidden content on pages whose CSS also conflicts border shorthand with longhand', async () => {
    const concealed = 'Concealed article behind conflicting border declarations. '.repeat(40)
    const visible = 'Visible article behind conflicting border declarations. '.repeat(40)
    const result = await applyReadability(
      `<html><head><style>span,article{margin:0;padding:0;border:0px;font-size:100%}.chrome{border-bottom:1px solid;display:none}</style></head><body><article class="chrome"><h1>Hidden</h1><p>${concealed}</p></article><article><h1>Visible</h1><p>${visible}</p></article></body></html>`,
      'https://example.com/border-shorthand-conflict',
    )

    expect(result).toContain('Visible article behind conflicting border declarations')
    expect(result).not.toContain('Concealed article behind conflicting border declarations')
  })
})

describe('buildComputedStyleResolver', () => {
  const resolverFor = async (css: string, inlineStyle = '') => {
    const { JSDOM } = await import('jsdom')
    const dom = new JSDOM(
      `<html><head><style>${css}</style></head><body><p class="a" style="${inlineStyle}">x</p></body></html>`,
    )
    const { document } = dom.window
    const resolve = buildComputedStyleResolver(document, (element) => dom.window.getComputedStyle(element))
    return { resolve, element: document.querySelector('p')! }
  }

  test('resolves the visibility properties pruning depends on', async () => {
    const { resolve, element } = await resolverFor('.a{border-bottom:3px solid red;display:none}')

    expect(resolve?.(element).display).toBe('none')
  })

  test('cannot resolve declarations pruning never reads, so jsdom never computes them', async () => {
    const { resolve, element } = await resolverFor('.a{border-bottom:3px solid red;display:none}')

    expect(resolve?.(element).borderBottomWidth).not.toBe('3px')
  })

  test('cannot resolve an inline shorthand/longhand conflict, the other route into the cascade', async () => {
    const { resolve, element } = await resolverFor(
      '.unused{color:red}',
      'border:0;border-bottom:1px solid;display:none',
    )

    expect(resolve?.(element).borderBottomStyle).not.toBe('solid')
  })

  test('keeps an inline custom property while removing the inline declarations it never reads', async () => {
    const { resolve, element } = await resolverFor(
      '.unused{color:red}',
      '--hidden:0;border:0;border-bottom:1px solid;display:none',
    )

    resolve?.(element)

    expect(Array.from((element as HTMLElement).style).toSorted()).toEqual(['--hidden', 'display'])
    expect((element as HTMLElement).style.getPropertyValue('--hidden')).toBe('0')
  })

  test('still resolves inline visibility declarations so inline pruning keeps working', async () => {
    const { resolve, element } = await resolverFor(
      '.unused{color:red}',
      'border:0;border-bottom:1px solid;display:none',
    )

    expect(resolve?.(element).display).toBe('none')
  })
})

describe('pruneHiddenContent', () => {
  test('reduces every inline style before resolving any element, including ancestors it prunes first', async () => {
    const { JSDOM } = await import('jsdom')
    const dom = new JSDOM(
      `<html><body><div hidden style="color:rgb(1,2,3);border:0;border-bottom:1px solid"><p>x</p></div><section style="position:absolute;left:-10000px;border:0;border-bottom:1px solid"><span>y</span></section></body></html>`,
    )
    const { document } = dom.window
    const unreduced: string[] = []

    pruneHiddenContent(document, (element) => {
      for (let node = element.parentElement; node !== null; node = node.parentElement) {
        const declarations = Array.from(node.style).filter((property) => !VISIBILITY_PROPERTIES.has(property))
        if (declarations.length > 0) unreduced.push(`${node.tagName}:${declarations.join(',')}`)
      }
      return dom.window.getComputedStyle(element)
    })

    expect(unreduced).toEqual([])
  })
})

describe('reduceToVisibilityDeclarations', () => {
  const styleElementsFor = async (css: string) => {
    const { JSDOM } = await import('jsdom')
    const dom = new JSDOM(`<html><head><style>${css}</style></head><body><p>x</p></body></html>`)
    return Array.from(dom.window.document.querySelectorAll('style'))
  }

  test('drops declarations that cannot affect visibility and keeps the ones that can', async () => {
    const styles = await styleElementsFor(
      '.a{border:0px;border-bottom:1px solid;transition:all 250ms;display:none;opacity:0;visibility:hidden;content-visibility:hidden}',
    )

    reduceToVisibilityDeclarations(styles)

    const rule = styles[0]!.sheet!.cssRules[0] as CSSStyleRule
    expect(Array.from(rule.style).toSorted()).toEqual(['content-visibility', 'display', 'opacity', 'visibility'])
  })

  test('keeps custom properties a retained visibility declaration could reference', async () => {
    const styles = await styleElementsFor('.a{--hidden:0;border:0px;transition:all 250ms;opacity:var(--hidden)}')

    reduceToVisibilityDeclarations(styles)

    const rule = styles[0]!.sheet!.cssRules[0] as CSSStyleRule
    expect(Array.from(rule.style).toSorted()).toEqual(['--hidden', 'opacity'])
    expect(rule.style.getPropertyValue('--hidden')).toBe('0')
  })

  test('reduces declarations nested inside grouping rules', async () => {
    const styles = await styleElementsFor('@media screen{@supports (display:grid){.a{border:0px;display:none}}}')

    reduceToVisibilityDeclarations(styles)

    const media = styles[0]!.sheet!.cssRules[0] as CSSGroupingRule
    const supports = media.cssRules[0] as CSSGroupingRule
    expect(Array.from((supports.cssRules[0] as CSSStyleRule).style)).toEqual(['display'])
  })

  test('leaves style textContent untouched so the complexity budgets still measure the original stylesheet', async () => {
    const css = '.a{border:0px;display:none}'
    const styles = await styleElementsFor(css)

    reduceToVisibilityDeclarations(styles)

    expect(styles[0]!.textContent).toBe(css)
  })
})
