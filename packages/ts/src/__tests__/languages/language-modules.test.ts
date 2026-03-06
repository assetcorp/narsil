import { describe, expect, it } from 'vitest'
import { chinese } from '../../languages/chinese'
import { dagbani } from '../../languages/dagbani'
import { ewe } from '../../languages/ewe'
import { ga } from '../../languages/ga'
import { hausa } from '../../languages/hausa'
import { igbo } from '../../languages/igbo'
import { japanese } from '../../languages/japanese'
import { twi } from '../../languages/twi'
import { yoruba } from '../../languages/yoruba'
import { zulu } from '../../languages/zulu'
import type { LanguageModule } from '../../types/language'

const modules: LanguageModule[] = [chinese, japanese, yoruba, hausa, igbo, zulu, dagbani, twi, ewe, ga]

function splitWith(mod: LanguageModule, text: string): string[] {
  const pattern = mod.tokenizer?.splitPattern
  if (!pattern) return [text]
  const re = new RegExp(pattern.source, pattern.flags)
  return text.split(re).filter(Boolean)
}

describe('all language modules', () => {
  for (const mod of modules) {
    describe(mod.name, () => {
      it('has stemmer set to null', () => {
        expect(mod.stemmer).toBeNull()
      })

      it('has a non-empty stop words set', () => {
        expect(mod.stopWords.size).toBeGreaterThan(0)
      })

      it('has a tokenizer config with splitPattern and minTokenLength 1', () => {
        expect(mod.tokenizer).toBeDefined()
        expect(mod.tokenizer?.splitPattern).toBeInstanceOf(RegExp)
        expect(mod.tokenizer?.minTokenLength).toBe(1)
      })

      it('splitPattern preserves every character used in stop words', () => {
        for (const word of mod.stopWords) {
          const parts = splitWith(mod, word)
          const rejoined = parts.join('')
          expect(rejoined).toBe(word)
        }
      })
    })
  }
})

describe('chinese tokenizer', () => {
  it('keeps CJK text as a single token when no separators are present', () => {
    expect(splitWith(chinese, '我是学生')).toEqual(['我是学生'])
  })

  it('splits on Chinese punctuation', () => {
    expect(splitWith(chinese, '你好，世界')).toEqual(['你好', '世界'])
  })

  it('recognizes common stop words', () => {
    expect(chinese.stopWords.has('的')).toBe(true)
    expect(chinese.stopWords.has('是')).toBe(true)
    expect(chinese.stopWords.has('不')).toBe(true)
    expect(chinese.stopWords.has('因为')).toBe(true)
  })
})

describe('japanese tokenizer', () => {
  it('keeps hiragana, katakana, and kanji together', () => {
    expect(splitWith(japanese, 'これはテスト文章')).toEqual(['これはテスト文章'])
  })

  it('preserves the iteration mark 々', () => {
    expect(splitWith(japanese, '我々')).toEqual(['我々'])
  })

  it('splits on non-CJK punctuation', () => {
    expect(splitWith(japanese, '東京、大阪')).toEqual(['東京', '大阪'])
  })

  it('recognizes particle stop words', () => {
    expect(japanese.stopWords.has('の')).toBe(true)
    expect(japanese.stopWords.has('は')).toBe(true)
    expect(japanese.stopWords.has('を')).toBe(true)
    expect(japanese.stopWords.has('が')).toBe(true)
  })

  it('recognizes the iteration mark word 我々 as a stop word', () => {
    expect(japanese.stopWords.has('我々')).toBe(true)
  })
})

describe('yoruba tokenizer', () => {
  it('preserves tone marks on vowels', () => {
    expect(splitWith(yoruba, 'àwọn ọjọ́')).toEqual(['àwọn', 'ọjọ́'])
  })

  it('preserves syllabic nasal ń', () => {
    expect(splitWith(yoruba, 'ó ń lọ')).toEqual(['ó', 'ń', 'lọ'])
  })

  it('preserves combined subdot and tone marks', () => {
    expect(splitWith(yoruba, 'rẹ̀ pẹ̀lú')).toEqual(['rẹ̀', 'pẹ̀lú'])
  })

  it('recognizes diacritized stop words', () => {
    expect(yoruba.stopWords.has('ṣùgbọ́n')).toBe(true)
    expect(yoruba.stopWords.has('àwọn')).toBe(true)
    expect(yoruba.stopWords.has('ń')).toBe(true)
  })

  it('has normalizeDiacritics set to false', () => {
    expect(yoruba.tokenizer?.normalizeDiacritics).toBe(false)
  })
})

describe('hausa tokenizer', () => {
  it('preserves implosive consonants ɓ and ɗ', () => {
    expect(splitWith(hausa, 'ɓangare ɗaya')).toEqual(['ɓangare', 'ɗaya'])
  })

  it('preserves ejective ƙ', () => {
    expect(splitWith(hausa, 'ƙasa')).toEqual(['ƙasa'])
  })

  it('preserves glottal stop ʼ (U+02BC)', () => {
    expect(splitWith(hausa, 'haʼinci')).toEqual(['haʼinci'])
  })

  it('recognizes common stop words', () => {
    expect(hausa.stopWords.has('da')).toBe(true)
    expect(hausa.stopWords.has('amma')).toBe(true)
    expect(hausa.stopWords.has('wannan')).toBe(true)
    expect(hausa.stopWords.has('saboda')).toBe(true)
  })
})

describe('igbo tokenizer', () => {
  it('preserves dotted vowels ị, ụ, ọ', () => {
    expect(splitWith(igbo, 'anyị bụ ndị')).toEqual(['anyị', 'bụ', 'ndị'])
  })

  it('recognizes both plain and diacritized stop word forms', () => {
    expect(igbo.stopWords.has('gi')).toBe(true)
    expect(igbo.stopWords.has('gị')).toBe(true)
    expect(igbo.stopWords.has('bu')).toBe(true)
    expect(igbo.stopWords.has('bụ')).toBe(true)
  })
})

describe('dagbani tokenizer', () => {
  it('preserves ɛ, ɔ, ŋ characters', () => {
    expect(splitWith(dagbani, 'bɛ ŋa yɛli')).toEqual(['bɛ', 'ŋa', 'yɛli'])
  })

  it('preserves schwa ə', () => {
    expect(splitWith(dagbani, 'də bə nə')).toEqual(['də', 'bə', 'nə'])
  })

  it('preserves ɣ and ʒ', () => {
    expect(splitWith(dagbani, 'ɣari ʒim')).toEqual(['ɣari', 'ʒim'])
  })

  it('recognizes stop words with schwa', () => {
    expect(dagbani.stopWords.has('də')).toBe(true)
    expect(dagbani.stopWords.has('bə')).toBe(true)
    expect(dagbani.stopWords.has('nə')).toBe(true)
  })
})

describe('twi tokenizer', () => {
  it('preserves ɛ and ɔ', () => {
    expect(splitWith(twi, 'ɔno ɛno yɛn')).toEqual(['ɔno', 'ɛno', 'yɛn'])
  })

  it('recognizes stop words with special characters', () => {
    expect(twi.stopWords.has('ɔno')).toBe(true)
    expect(twi.stopWords.has('ɛno')).toBe(true)
    expect(twi.stopWords.has('wɔn')).toBe(true)
    expect(twi.stopWords.has('sɛ')).toBe(true)
  })
})

describe('ewe tokenizer', () => {
  it('preserves ɛ, ɔ, ɖ, ŋ, ɣ characters', () => {
    expect(splitWith(ewe, 'ɛya ɖe ŋgɔ ɣe')).toEqual(['ɛya', 'ɖe', 'ŋgɔ', 'ɣe'])
  })

  it('preserves accented vowels (tone marks and nasalization)', () => {
    expect(splitWith(ewe, 'nyè wò mí wó hã')).toEqual(['nyè', 'wò', 'mí', 'wó', 'hã'])
  })

  it('recognizes stop words with tone marks', () => {
    expect(ewe.stopWords.has('nyè')).toBe(true)
    expect(ewe.stopWords.has('mí')).toBe(true)
    expect(ewe.stopWords.has('wó')).toBe(true)
    expect(ewe.stopWords.has('hã')).toBe(true)
  })
})

describe('ga tokenizer', () => {
  it('preserves ɛ, ɔ, ŋ characters', () => {
    expect(splitWith(ga, 'wɔ lɛ ŋmɛnɛ')).toEqual(['wɔ', 'lɛ', 'ŋmɛnɛ'])
  })

  it('recognizes common stop words', () => {
    expect(ga.stopWords.has('mi')).toBe(true)
    expect(ga.stopWords.has('wɔ')).toBe(true)
    expect(ga.stopWords.has('lɛ')).toBe(true)
    expect(ga.stopWords.has('kɛ')).toBe(true)
  })
})

describe('zulu tokenizer', () => {
  it('uses plain Latin splitPattern', () => {
    expect(splitWith(zulu, 'ukuthi kodwa futhi')).toEqual(['ukuthi', 'kodwa', 'futhi'])
  })

  it('recognizes subject concords', () => {
    expect(zulu.stopWords.has('ngi')).toBe(true)
    expect(zulu.stopWords.has('si')).toBe(true)
    expect(zulu.stopWords.has('ba')).toBe(true)
    expect(zulu.stopWords.has('li')).toBe(true)
  })

  it('recognizes demonstratives', () => {
    expect(zulu.stopWords.has('lesi')).toBe(true)
    expect(zulu.stopWords.has('leli')).toBe(true)
    expect(zulu.stopWords.has('lolu')).toBe(true)
  })
})
