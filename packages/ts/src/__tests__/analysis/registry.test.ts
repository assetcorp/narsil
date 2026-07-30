import { describe, expect, it } from 'vitest'
import {
  getStopWords,
  getTokenizer,
  hasStopWords,
  hasTokenizer,
  registerStopWords,
  registerTokenizer,
  resolveIndexAnalysis,
} from '../../analysis/registry'
import { NarsilError } from '../../errors'
import type { CustomTokenizer, IndexConfig } from '../../types/schema'

const schema = { title: 'string' as const }

const everyCharacter: CustomTokenizer = {
  tokenize(text: string) {
    return [...text].map((token, position) => ({ token, position }))
  },
}

describe('an analysis component registered under a name resolves by that name', () => {
  it('returns the tokenizer that was registered', () => {
    registerTokenizer('every-character', everyCharacter)

    expect(hasTokenizer('every-character')).toBe(true)
    expect(getTokenizer('every-character')).toBe(everyCharacter)
  })

  it('returns the stop words that were registered', () => {
    const words = new Set(['alpha', 'beta'])
    registerStopWords('greek-letters', words)

    expect(hasStopWords('greek-letters')).toBe(true)
    expect(getStopWords('greek-letters')).toBe(words)
  })

  it('refuses a tokenizer without a tokenize method', () => {
    expect(() => registerTokenizer('broken', {} as CustomTokenizer)).toThrow(NarsilError)
  })

  it('refuses a stop word set that is neither a Set nor a function', () => {
    expect(() => registerStopWords('broken', ['alpha'] as unknown as Set<string>)).toThrow(NarsilError)
  })

  it('refuses an empty name', () => {
    expect(() => registerTokenizer('   ', everyCharacter)).toThrow(NarsilError)
    expect(() => registerStopWords('', new Set())).toThrow(NarsilError)
  })

  it('reports a name nobody registered', () => {
    expect(hasTokenizer('absent')).toBe(false)
    expect(() => getTokenizer('absent')).toThrow(/is not registered/)
    expect(() => getStopWords('absent')).toThrow(/is not registered/)
  })
})

describe('an index config names or carries its analysis components', () => {
  it('resolves a named tokenizer and a named stop word set', () => {
    const words = new Set(['and'])
    registerTokenizer('named-tokenizer', everyCharacter)
    registerStopWords('named-stop-words', words)

    const config: IndexConfig = { schema, tokenizer: 'named-tokenizer', stopWords: 'named-stop-words' }

    expect(resolveIndexAnalysis(config)).toEqual({ customTokenizer: everyCharacter, stopWords: words })
  })

  it('passes an instance through untouched', () => {
    const words = new Set(['and'])
    const config: IndexConfig = { schema, tokenizer: everyCharacter, stopWords: words }

    expect(resolveIndexAnalysis(config)).toEqual({ customTokenizer: everyCharacter, stopWords: words })
  })

  it('leaves both undefined when the config names neither', () => {
    expect(resolveIndexAnalysis({ schema })).toEqual({ customTokenizer: undefined, stopWords: undefined })
  })

  it('fails loudly when the config names a component nobody registered', () => {
    expect(() => resolveIndexAnalysis({ schema, tokenizer: 'absent' })).toThrow(NarsilError)
  })
})
