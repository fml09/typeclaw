import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { MAX_ADAPTIVE_HTML_NESTING_DEPTH } from './adaptive-html'
import { _setForceFallbackForTest } from './fetch'
import { webFetchTool } from './tool'
import type { WebFetchDetails } from './types'

type FetchInput = Parameters<typeof fetch>[0]
type FetchArgs = { url: string; init: RequestInit | undefined }

let fetchCalls: FetchArgs[]
let fetchResponse: (args: FetchArgs) => Response | Promise<Response>
const originalFetch = globalThis.fetch

beforeEach(() => {
  fetchCalls = []
  globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const args = { url, init }
    fetchCalls.push(args)
    return fetchResponse(args)
  }) as typeof fetch
  // Force the Bun.fetch fallback transport so these tool-level tests don't
  // accidentally hit a real curl-impersonate binary on dev/CI environments
  // where it happens to be installed. fetch.test.ts owns curl-path coverage.
  _setForceFallbackForTest(true)
})

afterEach(() => {
  globalThis.fetch = originalFetch
  _setForceFallbackForTest(false)
})

const ctx = {} as Parameters<typeof webFetchTool.execute>[4]

function textOf(result: Awaited<ReturnType<typeof webFetchTool.execute>>): string {
  const part = result.content[0]
  return part?.type === 'text' ? part.text : ''
}

function detailsOf(result: Awaited<ReturnType<typeof webFetchTool.execute>>): WebFetchDetails {
  return result.details as WebFetchDetails
}

const ARTICLE_HTML = `
<!doctype html>
<html><head><title>Sample</title></head><body>
<article>
  <h1>Sample</h1>
  <p>This is a paragraph with enough body text for Readability to score the article positively and produce stable output across versions.</p>
  <p>A second paragraph adds reliability to the heuristic so the test does not depend on a single sentence.</p>
</article>
</body></html>`

function articleScriptForTool(body: string): string {
  return `<script type="application/ld+json">${JSON.stringify({
    '@type': 'Article',
    headline: 'Large article',
    articleBody: body,
  })}</script>`
}

describe('webfetch: URL handling', () => {
  test('rewrites bare hostnames to https://', async () => {
    fetchResponse = () => new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } })

    await webFetchTool.execute('id', { url: 'example.com' }, undefined, undefined, ctx)

    expect(fetchCalls[0]?.url).toBe('https://example.com/')
  })

  test('rejects non-http(s) schemes without a network call', async () => {
    fetchResponse = () => new Response('should not be called', { status: 500 })

    const result = await webFetchTool.execute('id', { url: 'file:///etc/passwd' }, undefined, undefined, ctx)

    expect(textOf(result)).toContain('http://')
    expect(detailsOf(result).error).toBe(true)
    expect(fetchCalls).toHaveLength(0)
  })
})

describe('webfetch: strategy auto-detection', () => {
  test('ordinary HTML article succeeds through readability with one diagnostic attempt', async () => {
    fetchResponse = () =>
      new Response(ARTICLE_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })

    const result = await webFetchTool.execute('id', { url: 'https://example.com/post' }, undefined, undefined, ctx)
    const details = detailsOf(result)

    expect(details.strategy).toBe('readability')
    expect(details.autoDetected).toBe(true)
    expect(details.extractionAttempts).toEqual([
      { route: 'readability', outcome: 'success', reason: 'Readability identified article content' },
    ])
    expect(textOf(result)).toContain('# Sample')
    expect(textOf(result)).toContain('paragraph with enough body text')
  })

  test('caps a rescued JSON-LD article at the readability output limit', async () => {
    const body = 'z'.repeat(220_000)
    fetchResponse = () =>
      new Response(`<html><body><div id="app"></div>${articleScriptForTool(body)}</body></html>`, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })

    const result = await webFetchTool.execute('id', { url: 'https://example.com/large' }, undefined, undefined, ctx)

    expect(detailsOf(result).truncated).toBe(true)
    expect(detailsOf(result).bytesOut).toBeLessThan(201_000)
    expect(textOf(result)).toContain('[Output truncated:')
  })

  test('falls back from unusable readability output to schema.org JSON-LD in order', async () => {
    const html = `<!doctype html><html><body>
      <nav>Home</nav>
      <script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'NewsArticle',
        headline: 'Structured report',
        articleBody:
          'This report contains enough substantive structured article content to rescue a page whose visible HTML is only an application shell.',
      })}</script>
    </body></html>`
    fetchResponse = () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })

    const result = await webFetchTool.execute('id', { url: 'https://example.com/report' }, undefined, undefined, ctx)

    expect(textOf(result)).toContain('# Structured report')
    expect(textOf(result)).toContain('substantive structured article content')
    expect(detailsOf(result).extractionAttempts).toEqual([
      { route: 'readability', outcome: 'unusable', reason: 'Readability identified only unstructured page chrome' },
      { route: 'json_ld', outcome: 'success', reason: 'extracted schema.org article content' },
    ])
    expect(fetchCalls).toHaveLength(1)
  })

  test('decodes encoded JSON-LD MIME syntax through safe fetch and adaptive extraction', async () => {
    const html = `<html><body><div>Shell</div>${articleScriptForTool('Encoded MIME body.').replace(
      'application/ld+json',
      'application&#x2f;ld+json',
    )}</body></html>`
    fetchResponse = () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })

    const result = await webFetchTool.execute('id', { url: 'https://example.com/encoded' }, undefined, undefined, ctx)

    expect(textOf(result)).toContain('Encoded MIME body.')
    expect(detailsOf(result).extractionAttempts?.at(-1)?.route).toBe('json_ld')
    expect(fetchCalls).toHaveLength(1)
  })

  test('decodes semicolonless numeric JSON-LD MIME syntax through safe fetch and adaptive extraction', async () => {
    const html = `<html><body><div>Shell</div>${articleScriptForTool('Semicolonless MIME body.').replace(
      'application/ld+json',
      'application&#47ld+json',
    )}</body></html>`
    fetchResponse = () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })

    const result = await webFetchTool.execute(
      'id',
      { url: 'https://example.com/semicolonless' },
      undefined,
      undefined,
      ctx,
    )

    expect(textOf(result)).toContain('Semicolonless MIME body.')
    expect(detailsOf(result).extractionAttempts?.at(-1)?.route).toBe('json_ld')
    expect(fetchCalls).toHaveLength(1)
  })

  test('ignores malformed and unrelated JSON-LD blocks', async () => {
    const html = `<!doctype html><html><body><div>Short shell</div>
      <script type="application/ld+json">{"@type":"Article",broken}</script>
      <script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'Product',
        description:
          'A long product description must not be mistaken for public article content by the fallback route.',
      })}</script>
    </body></html>`
    fetchResponse = () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })

    const result = await webFetchTool.execute('id', { url: 'https://example.com/app' }, undefined, undefined, ctx)

    expect(detailsOf(result).error).toBe(true)
    expect(detailsOf(result).extractionAttempts).toEqual([
      {
        route: 'readability',
        outcome: 'unusable',
        reason: 'Readability identified only unstructured page chrome',
      },
      { route: 'json_ld', outcome: 'unusable', reason: 'no schema.org article content found' },
    ])
  })

  test('rejects a false-success HTML shell and keeps diagnostics free of fetched content', async () => {
    const secretShell = 'SHELL_MARKER_7f93'
    fetchResponse = () =>
      new Response(`<html><body><div>${secretShell}</div></body></html>`, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })

    const result = await webFetchTool.execute('id', { url: 'https://example.com/shell' }, undefined, undefined, ctx)
    const details = detailsOf(result)

    expect(details.error).toBe(true)
    expect(textOf(result)).toContain('browser retrieval may be needed')
    expect(details.extractionAttempts?.map(({ route, outcome }) => ({ route, outcome }))).toEqual([
      { route: 'readability', outcome: 'unusable' },
      { route: 'json_ld', outcome: 'unusable' },
    ])
    expect(JSON.stringify(details.extractionAttempts)).not.toContain(secretShell)
  })

  test('extracts non-English schema.org article content', async () => {
    const html = `<html><body><div>앱</div><script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebSite', name: '예시' },
        {
          '@type': 'BlogPosting',
          headline: '구조화된 소식',
          articleBody:
            '이 글은 구조화된 데이터에 담긴 충분히 의미 있는 한국어 본문입니다. 화면에는 짧은 앱 셸만 있지만 공개된 기사 내용을 안전하게 추출할 수 있습니다.',
        },
      ],
    })}</script></body></html>`
    fetchResponse = () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })

    const result = await webFetchTool.execute('id', { url: 'https://example.com/ko' }, undefined, undefined, ctx)

    expect(detailsOf(result).error).toBeUndefined()
    expect(textOf(result)).toContain('# 구조화된 소식')
    expect(textOf(result)).toContain('의미 있는 한국어 본문')
    expect(detailsOf(result).extractionAttempts?.[1]?.route).toBe('json_ld')
  })

  test('JSON content-type without explicit strategy returns a guidance error', async () => {
    fetchResponse = () => new Response('{"a":1}', { status: 200, headers: { 'content-type': 'application/json' } })

    const result = await webFetchTool.execute('id', { url: 'https://api.example.com/x' }, undefined, undefined, ctx)

    expect(textOf(result)).toMatch(/strategy: "jq"/)
    expect(detailsOf(result).error).toBe(true)
  })

  test('text/plain content-type defaults to raw', async () => {
    fetchResponse = () => new Response('hello world', { status: 200, headers: { 'content-type': 'text/plain' } })

    const result = await webFetchTool.execute('id', { url: 'https://example.com/r.txt' }, undefined, undefined, ctx)

    expect(detailsOf(result).strategy).toBe('raw')
    expect(detailsOf(result).autoDetected).toBe(true)
    expect(textOf(result)).toBe('hello world')
  })
})

describe('webfetch: explicit strategies', () => {
  test('jq strategy executes a query against JSON response', async () => {
    fetchResponse = () =>
      new Response('{"items":[{"name":"a"},{"name":"b"}]}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })

    const result = await webFetchTool.execute(
      'id',
      { url: 'https://api.example.com/x', strategy: 'jq', query: '.items[].name' },
      undefined,
      undefined,
      ctx,
    )

    expect(textOf(result)).toBe('"a"\n"b"')
    expect(detailsOf(result).strategy).toBe('jq')
    expect(detailsOf(result).autoDetected).toBe(false)
  })

  test('jq without query returns a missing-arg error before parsing', async () => {
    fetchResponse = () => new Response('{"a":1}', { status: 200, headers: { 'content-type': 'application/json' } })

    const result = await webFetchTool.execute(
      'id',
      { url: 'https://api.example.com/x', strategy: 'jq' },
      undefined,
      undefined,
      ctx,
    )

    expect(textOf(result)).toContain('Missing required arg `query`')
    expect(detailsOf(result).error).toBe(true)
  })

  test('selector strategy returns text of matching nodes', async () => {
    fetchResponse = () =>
      new Response('<html><body><span class="price">$9.99</span></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })

    const result = await webFetchTool.execute(
      'id',
      { url: 'https://shop.example.com/p', strategy: 'selector', selector: '.price' },
      undefined,
      undefined,
      ctx,
    )

    expect(textOf(result)).toContain('$9.99')
    expect(detailsOf(result).strategy).toBe('selector')
  })

  test('grep strategy filters lines from a text response', async () => {
    const body = ['alpha', 'beta', 'gamma alpha', 'delta'].join('\n')
    fetchResponse = () => new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } })

    const result = await webFetchTool.execute(
      'id',
      { url: 'https://example.com/list.txt', strategy: 'grep', pattern: 'alpha' },
      undefined,
      undefined,
      ctx,
    )

    expect(textOf(result)).toContain('1:alpha')
    expect(textOf(result)).toContain('3:gamma alpha')
    expect(textOf(result)).not.toContain('beta')
  })

  test('snapshot strategy summarizes page structure', async () => {
    fetchResponse = () =>
      new Response('<html><body><nav><a href="/x">X</a></nav></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })

    const result = await webFetchTool.execute(
      'id',
      { url: 'https://example.com/', strategy: 'snapshot' },
      undefined,
      undefined,
      ctx,
    )

    expect(textOf(result)).toContain('navigation')
    expect(textOf(result)).toContain('link: "X" → /x')
  })

  test('raw strategy passes the body through unchanged', async () => {
    fetchResponse = () =>
      new Response('<html>raw body</html>', { status: 200, headers: { 'content-type': 'text/html' } })

    const result = await webFetchTool.execute(
      'id',
      { url: 'https://example.com/', strategy: 'raw' },
      undefined,
      undefined,
      ctx,
    )

    expect(textOf(result)).toBe('<html>raw body</html>')
    expect(detailsOf(result).extractionAttempts).toBeUndefined()
  })

  test('explicit readability preserves its existing empty-page result without adaptive fallback', async () => {
    fetchResponse = () => new Response('<html><body></body></html>', { headers: { 'content-type': 'text/html' } })

    const result = await webFetchTool.execute(
      'id',
      { url: 'https://example.com/empty', strategy: 'readability' },
      undefined,
      undefined,
      ctx,
    )

    expect(textOf(result)).toBe('Readability extracted no content from this page.')
    expect(detailsOf(result).error).toBeUndefined()
    expect(detailsOf(result).autoDetected).toBe(false)
    expect(detailsOf(result).extractionAttempts).toBeUndefined()
  })

  test('explicit readability preserves ordinary article output without adaptive diagnostics', async () => {
    fetchResponse = () => new Response(ARTICLE_HTML, { headers: { 'content-type': 'text/html' } })

    const result = await webFetchTool.execute(
      'id',
      { url: 'https://example.com/article', strategy: 'readability' },
      undefined,
      undefined,
      ctx,
    )

    expect(textOf(result)).toContain('# Sample')
    expect(detailsOf(result).error).toBeUndefined()
    expect(detailsOf(result).autoDetected).toBe(false)
    expect(detailsOf(result).extractionAttempts).toBeUndefined()
  })

  test('explicit readability preserves source-visible content with an unresolved linked stylesheet', async () => {
    fetchResponse = () =>
      new Response(
        `<html><head><link rel="stylesheet" href="/site.css"></head><body><article><h1>Visible</h1><p>${'Source-visible linked stylesheet article. '.repeat(40)}</p></article></body></html>`,
        { headers: { 'content-type': 'text/html' } },
      )

    const result = await webFetchTool.execute(
      'id',
      { url: 'https://example.com/stylesheet', strategy: 'readability' },
      undefined,
      undefined,
      ctx,
    )

    expect(textOf(result)).toContain('Source-visible linked stylesheet article')
    expect(detailsOf(result).error).toBeUndefined()
    expect(detailsOf(result).strategy).toBe('readability')
    expect(detailsOf(result).autoDetected).toBe(false)
    expect(detailsOf(result).extractionAttempts).toBeUndefined()
  })

  test('explicit readability rejects deeply nested HTML before invoking the DOM parser', async () => {
    fetchResponse = () =>
      new Response('<div>'.repeat(MAX_ADAPTIVE_HTML_NESTING_DEPTH + 1), {
        headers: { 'content-type': 'text/html' },
      })

    const result = await webFetchTool.execute(
      'id',
      { url: 'https://example.com/deep', strategy: 'readability' },
      undefined,
      undefined,
      ctx,
    )

    expect(textOf(result)).toBe('adaptive HTML complexity limit exceeded')
    expect(detailsOf(result).error).toBe(true)
    expect(detailsOf(result).strategy).toBe('readability')
    expect(detailsOf(result).autoDetected).toBe(false)
    expect(detailsOf(result).extractionAttempts).toBeUndefined()
  })

  test('explicit readability rejects excessive start-tag attributes before invoking the DOM parser', async () => {
    const attributes = Array.from({ length: 15_000 }, (_, index) => ` data-${index}="x"`).join('')
    fetchResponse = () =>
      new Response(`<main${attributes}>content</main>`, {
        headers: { 'content-type': 'text/html' },
      })

    const result = await webFetchTool.execute(
      'id',
      { url: 'https://example.com/attributes', strategy: 'readability' },
      undefined,
      undefined,
      ctx,
    )

    expect(textOf(result)).toBe('adaptive HTML complexity limit exceeded')
    expect(detailsOf(result).error).toBe(true)
    expect(detailsOf(result).strategy).toBe('readability')
    expect(detailsOf(result).autoDetected).toBe(false)
  })
})

describe('webfetch: errors and limits', () => {
  test('non-2xx response surfaces the status', async () => {
    fetchResponse = () => new Response('nope', { status: 500, statusText: 'Internal Server Error' })

    const result = await webFetchTool.execute('id', { url: 'https://example.com/' }, undefined, undefined, ctx)

    expect(textOf(result)).toContain('HTTP 500')
    expect(detailsOf(result).error).toBe(true)
  })

  test('truncates output when over the per-strategy cap and appends a footer', async () => {
    const big = 'x'.repeat(110_000)
    fetchResponse = () => new Response(big, { status: 200, headers: { 'content-type': 'text/plain' } })

    const result = await webFetchTool.execute('id', { url: 'https://example.com/big' }, undefined, undefined, ctx)
    const details = detailsOf(result)

    expect(details.truncated).toBe(true)
    expect(textOf(result)).toContain('[Output truncated:')
    expect(details.bytesOut).toBeLessThan(101_000)
  })

  test('does not throw on network failure (errors flow through details.error)', async () => {
    fetchResponse = () => {
      throw new Error('ECONNREFUSED')
    }

    const result = await webFetchTool.execute('id', { url: 'https://example.com/' }, undefined, undefined, ctx)

    expect(textOf(result)).toContain('ECONNREFUSED')
    expect(detailsOf(result).error).toBe(true)
  })
})
