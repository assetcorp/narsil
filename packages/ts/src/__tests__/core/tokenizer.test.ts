import { describe, it, expect, beforeEach } from 'vitest'
import { tokenize, clearNormalizationCache } from '../../core/tokenizer'
import { english } from '../../languages/english'
import type { LanguageModule } from '../../types/language'

beforeEach(() => {
  clearNormalizationCache()
})

describe('tokenize', () => {
  it('splits text into tokens with positions', () => {
    const result = tokenize('hello world', english, { stem: false, removeStopWords: false })
    expect(result.tokens).toEqual([
      { token: 'hello', position: 0 },
      { token: 'world', position: 1 },
    ])
  })

  it('lowercases all tokens', () => {
    const result = tokenize('Hello WORLD', english, { stem: false, removeStopWords: false })
    expect(result.tokens.map(t => t.token)).toEqual(['hello', 'world'])
  })

  it('applies NFC normalization', () => {
    const combining = 'e\u0301' // e + combining acute = é
    const precomposed = '\u00e9' // é
    const r1 = tokenize(combining, english, { stem: false, removeStopWords: false, removeDiacritics: true })
    const r2 = tokenize(precomposed, english, { stem: false, removeStopWords: false, removeDiacritics: true })
    expect(r1.tokens[0].token).toBe(r2.tokens[0].token)
  })

  it('removes stop words when enabled', () => {
    const result = tokenize('the quick brown fox', english, { stem: false, removeStopWords: true })
    const words = result.tokens.map(t => t.token)
    expect(words).not.toContain('the')
    expect(words).toContain('quick')
    expect(words).toContain('brown')
    expect(words).toContain('fox')
  })

  it('preserves stop words when disabled', () => {
    const result = tokenize('the quick fox', english, { stem: false, removeStopWords: false })
    const words = result.tokens.map(t => t.token)
    expect(words).toContain('the')
  })

  it('applies stemming when enabled', () => {
    const result = tokenize('running cats', english, { stem: true, removeStopWords: false })
    expect(result.tokens[0].token).toBe('run')
    expect(result.tokens[1].token).toBe('cat')
  })

  it('preserves original (pre-stem) tokens in originalTokens array', () => {
    const result = tokenize('running cats', english, { stem: true, removeStopWords: false })
    expect(result.originalTokens).toEqual(['running', 'cats'])
  })

  it('removes diacritics when enabled', () => {
    const result = tokenize('café résumé', english, {
      stem: false,
      removeStopWords: false,
      removeDiacritics: true,
    })
    expect(result.tokens.map(t => t.token)).toEqual(['cafe', 'resume'])
  })

  it('preserves diacritics when disabled', () => {
    const result = tokenize('café', english, {
      stem: false,
      removeStopWords: false,
      removeDiacritics: false,
    })
    expect(result.tokens[0].token).toBe('café')
  })

  it('splits on punctuation', () => {
    const result = tokenize('hello, world! foo-bar', english, { stem: false, removeStopWords: false })
    const words = result.tokens.map(t => t.token)
    expect(words).toContain('hello')
    expect(words).toContain('world')
  })

  it('tracks positions correctly with stop word gaps', () => {
    const result = tokenize('the quick brown fox', english, { stem: false, removeStopWords: true })
    expect(result.tokens[0]).toEqual({ token: 'quick', position: 1 })
    expect(result.tokens[1]).toEqual({ token: 'brown', position: 2 })
    expect(result.tokens[2]).toEqual({ token: 'fox', position: 3 })
  })

  it('handles empty string', () => {
    const result = tokenize('', english, { stem: false, removeStopWords: false })
    expect(result.tokens).toEqual([])
  })

  it('handles string with only stop words', () => {
    const result = tokenize('the a an', english, { stem: false, removeStopWords: true })
    expect(result.tokens).toEqual([])
  })

  it('uses custom tokenizer when provided', () => {
    const custom = {
      tokenize: (text: string) => text.split('|').map((t, i) => ({ token: t.trim(), position: i })),
    }
    const result = tokenize('alpha|beta|gamma', english, { customTokenizer: custom })
    expect(result.tokens).toEqual([
      { token: 'alpha', position: 0 },
      { token: 'beta', position: 1 },
      { token: 'gamma', position: 2 },
    ])
  })

  it('accepts stop word override as a Set', () => {
    const customStops = new Set(['quick', 'fox'])
    const result = tokenize('the quick brown fox', english, {
      stem: false,
      removeStopWords: true,
      stopWordOverride: customStops,
    })
    const words = result.tokens.map(t => t.token)
    expect(words).toContain('the')
    expect(words).not.toContain('quick')
    expect(words).toContain('brown')
    expect(words).not.toContain('fox')
  })

  it('accepts stop word override as a function', () => {
    const overrideFn = (defaults: Set<string>) => {
      const merged = new Set(defaults)
      merged.add('custom')
      return merged
    }
    const result = tokenize('the custom word', english, {
      stem: false,
      removeStopWords: true,
      stopWordOverride: overrideFn,
    })
    const words = result.tokens.map(t => t.token)
    expect(words).not.toContain('the')
    expect(words).not.toContain('custom')
    expect(words).toContain('word')
  })

  it('uses normalization cache on repeated calls', () => {
    const r1 = tokenize('running', english, { stem: true, removeStopWords: false })
    const r2 = tokenize('running', english, { stem: true, removeStopWords: false })
    expect(r1.tokens[0].token).toBe(r2.tokens[0].token)
  })

  it('produces correct results when same token is cached with different options', () => {
    const stemmed = tokenize('running', english, { stem: true, removeStopWords: false })
    const unstemmed = tokenize('running', english, { stem: false, removeStopWords: false })
    expect(stemmed.tokens[0].token).toBe('run')
    expect(unstemmed.tokens[0].token).toBe('running')
  })

  it('respects language-specific split pattern', () => {
    const custom: LanguageModule = {
      name: 'custom',
      stemmer: null,
      stopWords: new Set(),
      tokenizer: { splitPattern: /;/ },
    }
    const result = tokenize('hello;world test', custom, { stem: false, removeStopWords: false })
    expect(result.tokens.map(t => t.token)).toEqual(['hello', 'world test'])
  })

  it('respects language-level normalizeDiacritics', () => {
    const lang: LanguageModule = {
      name: 'diacritic-lang',
      stemmer: null,
      stopWords: new Set(),
      tokenizer: { normalizeDiacritics: true },
    }
    const result = tokenize('café', lang, { stem: false, removeStopWords: false })
    expect(result.tokens[0].token).toBe('cafe')
  })

  it('respects language-level minTokenLength', () => {
    const lang: LanguageModule = {
      name: 'min3',
      stemmer: null,
      stopWords: new Set(),
      tokenizer: { minTokenLength: 3 },
    }
    const result = tokenize('a ab abc abcd', lang, { stem: false, removeStopWords: false })
    expect(result.tokens.map(t => t.token)).toEqual(['abc', 'abcd'])
    expect(result.tokens[0].position).toBe(2)
    expect(result.tokens[1].position).toBe(3)
  })

  it('cache is not poisoned by stop word removal state', () => {
    const withStops = tokenize('the fox', english, { stem: false, removeStopWords: true })
    const withoutStops = tokenize('the fox', english, { stem: false, removeStopWords: false })
    expect(withStops.tokens.map(t => t.token)).toEqual(['fox'])
    expect(withoutStops.tokens.map(t => t.token)).toEqual(['the', 'fox'])
  })

  it('preserves correct positions when minTokenLength filters tokens', () => {
    const lang: LanguageModule = {
      name: 'min2',
      stemmer: null,
      stopWords: new Set(),
      tokenizer: { minTokenLength: 2 },
    }
    const result = tokenize('I am here', lang, { stem: false, removeStopWords: false })
    expect(result.tokens).toEqual([
      { token: 'am', position: 1 },
      { token: 'here', position: 2 },
    ])
  })

  it('defaults to using stemming and stop word removal', () => {
    const result = tokenize('the cats are running', english)
    const words = result.tokens.map(t => t.token)
    expect(words).not.toContain('the')
    expect(words).not.toContain('are')
    expect(words).toContain('cat')
    expect(words).toContain('run')
  })
})
