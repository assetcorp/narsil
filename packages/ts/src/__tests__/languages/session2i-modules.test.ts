import { describe, expect, it } from 'vitest'
import { arabic } from '../../languages/arabic'
import { bulgarian } from '../../languages/bulgarian'
import { greek } from '../../languages/greek'
import { hindi } from '../../languages/hindi'
import { indonesian } from '../../languages/indonesian'
import { irish } from '../../languages/irish'
import { nepali } from '../../languages/nepali'
import { sanskrit } from '../../languages/sanskrit'
import { serbian } from '../../languages/serbian'
import { slovenian } from '../../languages/slovenian'
import { swahili } from '../../languages/swahili'
import { tamil } from '../../languages/tamil'
import { ukrainian } from '../../languages/ukrainian'
import type { LanguageModule } from '../../types/language'

const allModules: LanguageModule[] = [
  bulgarian,
  ukrainian,
  slovenian,
  arabic,
  indonesian,
  swahili,
  sanskrit,
  hindi,
  nepali,
  tamil,
  irish,
  greek,
  serbian,
]

function splitWith(mod: LanguageModule, text: string): string[] {
  const pattern = mod.tokenizer?.splitPattern
  if (!pattern) return [text]
  const re = new RegExp(pattern.source, pattern.flags)
  return text.split(re).filter(Boolean)
}

describe('session 2I language modules: structural checks', () => {
  for (const mod of allModules) {
    describe(mod.name, () => {
      it('conforms to LanguageModule interface', () => {
        expect(typeof mod.name).toBe('string')
        expect(mod.stemmer).not.toBeNull()
        expect(typeof mod.stemmer).toBe('function')
        expect(mod.stopWords).toBeInstanceOf(Set)
        expect(mod.stopWords.size).toBeGreaterThan(0)
        expect(mod.tokenizer?.splitPattern).toBeInstanceOf(RegExp)
      })

      it('stemmer handles edge cases without crashing', () => {
        const stem = mod.stemmer as (token: string) => string
        expect(stem('')).toBe('')
        expect(stem('a')).toBe('a')
        expect(stem('ab')).toBe('ab')
      })

      it('stemmer processes all stop words without error', () => {
        const stem = mod.stemmer as (token: string) => string
        for (const sw of mod.stopWords) {
          expect(() => stem(sw)).not.toThrow()
        }
      })

      it('tokenizer preserves characters used in stop words', () => {
        for (const word of mod.stopWords) {
          const parts = splitWith(mod, word)
          const rejoined = parts.join('')
          expect(rejoined).toBe(word)
        }
      })
    })
  }
})

describe('irish stemmer', () => {
  const stem = irish.stemmer as (token: string) => string

  it('strips eclipsis mutations', () => {
    expect(stem('gcapall')).toBe('capall')
    expect(stem('bpáirc')).toBe('páirc')
  })

  it('strips lenition mutations', () => {
    expect(stem('bhean')).toBe('bean')
    expect(stem('fhear')).toBe('fear')
    expect(stem('thug')).toBe('tug')
  })

  it("strips d' and b' before vowels", () => {
    expect(stem("d'ith")).toBe('ith')
    expect(stem("b'éigean")).toBe('éigean')
  })

  it('tokenizer preserves fada vowels', () => {
    expect(splitWith(irish, 'áéíóú')).toEqual(['áéíóú'])
  })
})

describe('indonesian stemmer', () => {
  const stem = indonesian.stemmer as (token: string) => string

  it('removes particles including -tah', () => {
    expect(stem('biarlah')).toBe('biar')
    expect(stem('apatah')).toBe('apa')
    expect(stem('adapun')).toBe('ada')
  })

  it('removes possessive suffixes', () => {
    expect(stem('bukuku')).toBe('buku')
    expect(stem('bukunya')).toBe('buku')
  })

  it('handles prefix me- forms', () => {
    expect(stem('memukul')).toBe('pukul')
  })

  it('handles belajar special case', () => {
    expect(stem('belajar')).toBe('ajar')
  })
})

describe('arabic stemmer', () => {
  const stem = arabic.stemmer as (token: string) => string

  it('strips definite article', () => {
    expect(stem('الكتاب')).toBe('كتاب')
  })

  it('strips diacritics', () => {
    expect(stem('كِتَاب')).toBe('كتاب')
  })
})

describe('bulgarian stemmer', () => {
  const stem = bulgarian.stemmer as (token: string) => string

  it('removes definite article and plural suffixes', () => {
    expect(stem('градът')).toBe('град')
    expect(stem('градове')).toBe('град')
  })
})

describe('ukrainian stemmer', () => {
  const stem = ukrainian.stemmer as (token: string) => string

  it('strips suffixes', () => {
    expect(stem('красивий')).toBe('красив')
  })

  it('tokenizer preserves Ukrainian-specific і, ї, є, ґ', () => {
    expect(splitWith(ukrainian, 'їхній ґанок єдність')).toEqual(['їхній', 'ґанок', 'єдність'])
  })
})

describe('greek stemmer', () => {
  const stem = greek.stemmer as (token: string) => string

  it('normalizes accented vowels before stemming', () => {
    expect(stem('γλώσσα')).toBe(stem('γλωσσα'))
  })

  it('strips noun case endings', () => {
    expect(stem('ανθρωπων').length).toBeLessThan('ανθρωπων'.length)
  })
})

describe('sanskrit stemmer', () => {
  const stem = sanskrit.stemmer as (token: string) => string

  it('strips nominal endings', () => {
    expect(stem('गच्छन्तु')).not.toBe('गच्छन्तु')
  })

  it('preserves words below minimum length', () => {
    expect(stem('तत्')).toBe('तत्')
  })
})

describe('hindi stemmer', () => {
  const stem = hindi.stemmer as (token: string) => string

  it('strips verb suffixes', () => {
    expect(stem('करता').length).toBeLessThan('करता'.length)
  })
})

describe('nepali stemmer', () => {
  const stem = nepali.stemmer as (token: string) => string

  it('strips postpositions', () => {
    expect(stem('घरमा')).toBe('घर')
  })
})

describe('tamil stemmer', () => {
  const stem = tamil.stemmer as (token: string) => string

  it('strips case suffixes', () => {
    expect(stem('நாட்டுக்கு')).toBe('நாட்டு')
  })
})

describe('serbian stemmer', () => {
  const stem = serbian.stemmer as (token: string) => string

  it('strips common suffixes', () => {
    expect(stem('градови').length).toBeLessThan('градови'.length)
  })
})

describe('slovenian stemmer', () => {
  const stem = slovenian.stemmer as (token: string) => string

  it('strips noun suffixes', () => {
    expect(stem('človekom').length).toBeLessThan('človekom'.length)
  })

  it('tokenizer preserves čšž', () => {
    expect(splitWith(slovenian, 'človek šola žaba')).toEqual(['človek', 'šola', 'žaba'])
  })
})

describe('swahili stemmer', () => {
  const stem = swahili.stemmer as (token: string) => string

  it('strips verb prefixes', () => {
    expect(stem('anasoma').length).toBeLessThan('anasoma'.length)
  })
})
