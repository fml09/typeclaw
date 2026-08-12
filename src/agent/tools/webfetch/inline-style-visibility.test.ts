import { describe, expect, test } from 'bun:test'

import { classifyRawInlineStyleVisibility } from './inline-style-visibility'

describe('classifyRawInlineStyleVisibility', () => {
  for (const style of [
    String.raw`display:n\6fne`,
    String.raw`visibility:h\69 dden`,
    String.raw`d\69splay:none`,
    String.raw`visib\69lity:hidden`,
    String.raw`opac\69ty:0`,
    String.raw`display:n\6f/**/ne`,
    '--label:"x; display:block";display:none',
    'background:url("data:image/svg+xml;display:block");display:none',
    'display:none;--x:func(;display:block;)',
    'display:none;--x:{;display:block;}',
    'display:no\
ne',
    'opacity:-0.1',
    'opacity:0%',
    'opacity:calc(0)',
    'opacity:calc( /**/ 0% /**/ )',
  ]) {
    test(`classifies ${style} as hidden`, () => {
      expect(classifyRawInlineStyleVisibility(style)).toBe('hidden')
    })
  }

  for (const style of [
    'opacity:+',
    'opacity:0e',
    'opacity:calc(0 + 0)',
    'opacity:calc(1)',
    'opacity:var(--opacity)',
    'display:bogus',
    'display:none;--x:func(;display:block;',
    'display:none;--x:[mismatched)',
    'display:none;--x:{unclosed',
    'display:none;--x:"unterminated',
    'display:none;--x:/* unterminated',
    'display:none;--x:bad\\',
    'display:none;--x:func(((((((((((((((((((((((((((((((((x)))))))))))))))))))))))))))))))))',
  ]) {
    test(`classifies ${style} as uncertain`, () => {
      expect(classifyRawInlineStyleVisibility(style)).toBe('uncertain')
    })
  }

  for (const style of [
    'opacity:0.1',
    'opacity:10%',
    'display:none;display:block',
    '--label:"x; display:none";display:block',
    '--url:url("data:image/svg+xml;display:none");display:block',
    '--label:"line\\\ncontinuation;display:none";display:block',
    '--url:url(data:image/svg+xml\\\n;base64,AAAA);display:block',
    '--tokens:{color:red; nested:[one(two)]};display:block',
    'display:initial;visibility:initial;opacity:initial',
  ]) {
    test(`classifies ${style} as visible`, () => {
      expect(classifyRawInlineStyleVisibility(style)).toBe('visible')
    })
  }

  test('uses the last relevant declaration for each property', () => {
    expect(classifyRawInlineStyleVisibility('display:block;display:none')).toBe('hidden')
    expect(classifyRawInlineStyleVisibility('content-visibility:hidden')).toBe('hidden')
    expect(classifyRawInlineStyleVisibility('content-visibility:visible')).toBe('visible')
    expect(classifyRawInlineStyleVisibility('opacity:0;opacity:1')).toBe('visible')
    expect(classifyRawInlineStyleVisibility('opacity:1;opacity:0e')).toBe('uncertain')
  })

  test('models important declarations ahead of normal declarations', () => {
    expect(classifyRawInlineStyleVisibility('display:none!important;display:block')).toBe('hidden')
    expect(classifyRawInlineStyleVisibility('display:none;display:block!important')).toBe('visible')
    expect(classifyRawInlineStyleVisibility('display:none!important;display:block!important')).toBe('visible')
    expect(classifyRawInlineStyleVisibility('display:block!important;display:none')).toBe('visible')
  })

  test('fails closed when malformed importance could change the result', () => {
    expect(classifyRawInlineStyleVisibility('display:block;display:none ! urgent')).toBe('uncertain')
  })

  for (const keyword of ['inherit', 'unset', 'revert', 'revert-layer']) {
    test(`classifies CSS-wide ${keyword} as uncertain without cascade context`, () => {
      expect(classifyRawInlineStyleVisibility(`display:${keyword}`)).toBe('uncertain')
      expect(classifyRawInlineStyleVisibility(`visibility:${keyword}`)).toBe('uncertain')
      expect(classifyRawInlineStyleVisibility(`opacity:${keyword}`)).toBe('uncertain')
    })
  }
})
