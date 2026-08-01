import { describe, expect, it } from 'vitest'
import { expandNgrams } from '../../../core/tokenizer'

const LEADING_MARK = /^\p{M}/u

function ngrams(part: string, size = 2): string[] {
  const out: string[] = []
  expandNgrams(part, size, out)
  return out
}

describe('a script written with spaces between its words', () => {
  it('leaves a Latin run whole', () => {
    expect(ngrams('narsil')).toEqual(['narsil'])
  })

  it('leaves a Latin run beside a Han run whole', () => {
    expect(ngrams('abc東京都')).toEqual(['abc', '東京', '京都'])
  })

  it('emits nothing for empty text', () => {
    expect(ngrams('')).toEqual([])
  })
})

describe('a script written without spaces between its words', () => {
  it('cuts Han into overlapping pairs', () => {
    expect(ngrams('東京都')).toEqual(['東京', '京都'])
  })

  it('leaves a run no longer than the size whole', () => {
    expect(ngrams('東京')).toEqual(['東京'])
    expect(ngrams('都')).toEqual(['都'])
  })

  it('cuts each part where the script changes', () => {
    expect(ngrams('東京タワー')).toEqual(['東京', 'タワ', 'ワー'])
  })

  it('cuts Hangul syllables into overlapping pairs', () => {
    expect(ngrams('대한민국')).toEqual(['대한', '한민', '민국'])
  })

  it('cuts Han beyond the basic plane into overlapping pairs', () => {
    expect(ngrams('𠀀𠀁𠀂')).toEqual(['𠀀𠀁', '𠀁𠀂'])
  })

  it('honours a size other than two', () => {
    expect(ngrams('東京都心', 3)).toEqual(['東京都', '京都心'])
  })
})

describe('Thai, Lao, Khmer, and Myanmar', () => {
  it('cuts Thai into overlapping pairs', () => {
    expect(ngrams('ภาษาไทย')).toEqual(['ภา', 'าษ', 'ษา', 'าไ', 'ไท', 'ทย'])
  })

  it('cuts Lao into overlapping pairs', () => {
    expect(ngrams('ພາສາລາວ')).toEqual(['ພາ', 'າສ', 'ສາ', 'າລ', 'ລາ', 'າວ'])
  })

  it('cuts Khmer into overlapping pairs', () => {
    expect(ngrams('ខ្មែរ')).toEqual(['ខ្មែ', 'មែរ'])
  })

  it('cuts Myanmar into overlapping pairs', () => {
    expect(ngrams('မြန်မာ')).toEqual(['မြန်', 'န်မာ'])
  })

  it('leaves a Thai run beside a Latin run whole', () => {
    expect(ngrams('ไทยabc')).toEqual(['ไท', 'ทย', 'abc'])
  })

  it('cuts between a Thai run and a Han run', () => {
    expect(ngrams('ไทย東京都')).toEqual(['ไท', 'ทย', '東京', '京都'])
  })
})

describe('a mark belongs to the character before it', () => {
  it('keeps a Thai vowel sign and tone mark with their consonant', () => {
    expect(ngrams('ผู้หญิง')).toEqual(['ผู้ห', 'หญิ', 'ญิง'])
  })

  it('keeps a Lao vowel sign with its consonant', () => {
    expect(ngrams('ເມືອງ')).toEqual(['ເມື', 'ມືອ', 'ອງ'])
  })

  it('counts a Myanmar consonant with its medial and vowel as one character', () => {
    expect(ngrams('ဘာသာ')).toEqual(['ဘာသာ'])
  })

  it('keeps an uncomposed voiced sound mark with its kana', () => {
    expect(ngrams('カ゚キ゚ク゚')).toEqual(['カ゚キ゚', 'キ゚ク゚'])
  })

  it('never begins an n-gram with a mark', () => {
    const written = ['ผู้หญิง', 'ที่นี่', 'ເມືອງ', 'ភាសាខ្មែរ', 'မြန်မာနိုင်ငံ', 'カ゚キ゚ク゚']
    const leading = written.flatMap(text => ngrams(text)).filter(gram => LEADING_MARK.test(gram))
    expect(leading).toEqual([])
  })

  it('keeps a mark that opens a part rather than losing it', () => {
    expect(ngrams('ิไทย').join('')).toContain('ิ')
  })
})

describe('expansion loses no text', () => {
  const written = [
    'ภาษาไทยเป็นภาษาราชการของประเทศไทย',
    'ພາສາລາວເປັນພາສາລາຊະການ',
    'ភាសាខ្មែរជាភាសាផ្លូវការ',
    'မြန်မာဘာသာသည်ရုံးသုံးဘာသာဖြစ်သည်',
    '東京都は日本の首都です',
    '대한민국의수도는서울입니다',
    'ไทยabc東京カタカナ대한',
  ]

  for (const text of written) {
    it(`keeps every character of "${text.slice(0, 16)}"`, () => {
      const produced = ngrams(text).join('')
      for (const character of text) {
        expect(produced).toContain(character)
      }
    })
  }
})
