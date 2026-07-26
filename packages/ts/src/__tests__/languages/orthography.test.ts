import { describe, expect, it } from 'vitest'
import { tokenize } from '../../core/tokenizer'
import type { LanguageModule } from '../../types/language'
import { languageFixtures } from './fixtures'

const RAW_ANALYSIS = { stem: false, removeStopWords: false } as const

function analyse(text: string, module: LanguageModule): string[] {
  return tokenize(text, module, RAW_ANALYSIS).tokens.map(entry => entry.token)
}

function meaningfulCharacters(text: string): string[] {
  return [...text.normalize('NFC').toLowerCase()].filter(char => /[\p{L}\p{M}\p{N}]/u.test(char)).sort()
}

describe('tokenizing published prose keeps every letter, mark, and digit', () => {
  for (const fixture of languageFixtures) {
    describe(fixture.module.name, () => {
      for (const sample of fixture.samples) {
        it(`loses nothing from "${sample.text.slice(0, 48)}"`, () => {
          const produced = analyse(sample.text, fixture.module).join('')
          expect(meaningfulCharacters(produced)).toEqual(meaningfulCharacters(sample.text))
        })
      }
    })
  }
})

describe('a word the language writes as one word indexes as one token', () => {
  for (const fixture of languageFixtures) {
    describe(fixture.module.name, () => {
      for (const word of fixture.indivisible) {
        it(`keeps "${word}" whole`, () => {
          expect(analyse(word, fixture.module)).toEqual([word.normalize('NFC').toLowerCase()])
        })
      }
    })
  }
})

describe('text the language writes as several words indexes as several tokens', () => {
  for (const fixture of languageFixtures) {
    describe(fixture.module.name, () => {
      for (const split of fixture.separates) {
        it(`splits "${split.text}"`, () => {
          expect(analyse(split.text, fixture.module)).toEqual(split.tokens)
        })
      }
    })
  }
})

describe('spellings the language treats as one word reach one token', () => {
  for (const fixture of languageFixtures) {
    describe(fixture.module.name, () => {
      for (const [left, right] of fixture.equivalent) {
        it(`indexes "${left}" and "${right}" alike`, () => {
          expect(analyse(left, fixture.module)).toEqual(analyse(right, fixture.module))
        })
      }
    })
  }
})

describe('every stop word survives its own language tokenizer', () => {
  for (const fixture of languageFixtures) {
    it(`${fixture.module.name} keeps each stop word addressable`, () => {
      const broken: string[] = []
      for (const word of fixture.module.stopWords) {
        const produced = analyse(word, fixture.module)
        if (produced.length !== 1 || produced[0] !== word.normalize('NFC').toLowerCase()) {
          broken.push(word)
        }
      }
      expect(broken).toEqual([])
    })
  }
})
