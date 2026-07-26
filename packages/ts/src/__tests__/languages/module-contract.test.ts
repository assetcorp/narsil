import { describe, expect, it } from 'vitest'
import type { LanguageModule } from '../../types/language'
import { languageFixtures } from './fixtures'

const EDGE_CASE_TOKENS = ['', 'a', 'ab']

function splitWith(module: LanguageModule, text: string): string[] {
  const pattern = module.tokenizer?.splitPattern
  if (!pattern) return [text]
  return text.split(new RegExp(pattern.source, pattern.flags)).filter(Boolean)
}

describe('every language module honours the LanguageModule contract', () => {
  for (const { module } of languageFixtures) {
    describe(module.name, () => {
      it('names itself after its own file', () => {
        expect(typeof module.name).toBe('string')
        expect(module.name.length).toBeGreaterThan(0)
      })

      it('carries stop words', () => {
        expect(module.stopWords).toBeInstanceOf(Set)
        expect(module.stopWords.size).toBeGreaterThan(0)
      })

      it('declares a stemmer or declares that it has none', () => {
        expect(module.stemmer === null || typeof module.stemmer === 'function').toBe(true)
      })

      it('splits on a pattern the tokenizer can reuse', () => {
        const pattern = module.tokenizer?.splitPattern
        if (pattern) expect(pattern).toBeInstanceOf(RegExp)
      })

      it('keeps every character its own stop words are spelled with', () => {
        const damaged = [...module.stopWords].filter(word => splitWith(module, word).join('') !== word)
        expect(damaged).toEqual([])
      })

      if (module.stemmer) {
        const stem = module.stemmer

        it('stems short input without throwing', () => {
          for (const token of EDGE_CASE_TOKENS) {
            expect(() => stem(token)).not.toThrow()
          }
        })

        it('stems every one of its own stop words without throwing', () => {
          for (const word of module.stopWords) {
            expect(() => stem(word)).not.toThrow()
          }
        })
      }
    })
  }
})
