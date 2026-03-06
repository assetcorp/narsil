import type { LanguageModule } from '../types/language'

const VOWELS = 'aáeéiíoóöőuúüű'

function isVowel(ch: string): boolean {
  return VOWELS.includes(ch)
}

const DOUBLE_CONSONANTS: [string, string][] = [
  ['ccs', 'cs'],
  ['ggy', 'gy'],
  ['lly', 'ly'],
  ['nny', 'ny'],
  ['ssz', 'sz'],
  ['tty', 'ty'],
  ['zzs', 'zs'],
  ['bb', 'b'],
  ['cc', 'c'],
  ['dd', 'd'],
  ['ff', 'f'],
  ['gg', 'g'],
  ['jj', 'j'],
  ['kk', 'k'],
  ['ll', 'l'],
  ['mm', 'm'],
  ['nn', 'n'],
  ['pp', 'p'],
  ['rr', 'r'],
  ['ss', 's'],
  ['tt', 't'],
  ['vv', 'v'],
  ['zz', 'z'],
]

const DIGRAPH_STARTS = ['dzs', 'cs', 'dz', 'gy', 'ly', 'ny', 'sz', 'ty', 'zs']

const STEP1_SUFFIXES = ['al', 'el']

const STEP2_SUFFIXES = [
  'képpen',
  'onként',
  'enként',
  'anként',
  'ként',
  'képp',
  'ban',
  'ben',
  'nak',
  'nek',
  'val',
  'vel',
  'ból',
  'ról',
  'tól',
  'böl',
  'ről',
  'től',
  'nál',
  'nél',
  'hoz',
  'hez',
  'höz',
  'vá',
  'vé',
  'ba',
  'be',
  'ra',
  're',
  'an',
  'en',
  'on',
  'ön',
  'ért',
  'kor',
  'ig',
  'at',
  'et',
  'ot',
  'öt',
  'ul',
  'ül',
  'n',
  't',
]

const STEP3_SUFFIXES = ['ánként', 'án', 'én']

const STEP4_SUFFIXES = ['ástul', 'éstül', 'astul', 'estül', 'stul', 'stül']

const STEP5_SUFFIXES = ['á', 'é']

const STEP6_SUFFIXES = [
  'ékéi',
  'áéi',
  'ééi',
  'áké',
  'éké',
  'okéé',
  'ökéé',
  'akéé',
  'ekéé',
  'oké',
  'öké',
  'aké',
  'eké',
  'éé',
  'éi',
  'ké',
  'é',
]

const STEP7_SUFFIXES = [
  'ájuk',
  'éjük',
  'juk',
  'jük',
  'ánk',
  'énk',
  'ünk',
  'unk',
  'ám',
  'ém',
  'ád',
  'éd',
  'uk',
  'ük',
  'ja',
  'je',
  'am',
  'em',
  'om',
  'ad',
  'ed',
  'od',
  'öd',
  'á',
  'é',
  'a',
  'e',
  'o',
  'nk',
  'm',
  'd',
]

const STEP8_SUFFIXES = [
  'jaitok',
  'jeitek',
  'áitok',
  'éitek',
  'jaink',
  'jeink',
  'áink',
  'éink',
  'jaim',
  'jeim',
  'jaid',
  'jeid',
  'jaik',
  'jeik',
  'áim',
  'éim',
  'áid',
  'éid',
  'áik',
  'éik',
  'jai',
  'jei',
  'ái',
  'éi',
  'aink',
  'eink',
  'aim',
  'eim',
  'aid',
  'eid',
  'aik',
  'eik',
  'ai',
  'ei',
  'itek',
  'ink',
  'im',
  'id',
  'ik',
  'i',
]

const STEP9_SUFFIXES = ['ák', 'ék', 'ök', 'ok', 'ek', 'ak', 'k']

function computeR1(word: string): number {
  if (word.length === 0) return 0

  let i = 0

  if (isVowel(word[0])) {
    i = 1
    while (i < word.length && isVowel(word[i])) i++
    if (i >= word.length) return word.length

    let advanced = false
    for (const dg of DIGRAPH_STARTS) {
      if (word.startsWith(dg, i)) {
        i += dg.length
        advanced = true
        break
      }
    }
    if (!advanced) i++
  } else {
    let advanced = false
    for (const dg of DIGRAPH_STARTS) {
      if (word.startsWith(dg, 0)) {
        i = dg.length
        advanced = true
        break
      }
    }
    if (!advanced) i = 1

    while (i < word.length && !isVowel(word[i])) i++
    if (i >= word.length) return word.length
    i++
  }

  if (i <= word.length) return i

  return word.length
}

function endsWithDouble(word: string): boolean {
  return DOUBLE_CONSONANTS.some(([dbl]) => word.endsWith(dbl))
}

function undoubleConsonant(word: string): string {
  for (const [dbl, single] of DOUBLE_CONSONANTS) {
    if (word.endsWith(dbl)) {
      return word.slice(0, word.length - dbl.length) + single
    }
  }
  return word
}

function inR1(word: string, r1: number, suffixLen: number): boolean {
  return word.length - suffixLen >= r1
}

function trySuffix(word: string, suffixes: string[]): string | null {
  for (const s of suffixes) {
    if (word.endsWith(s)) return s
  }
  return null
}

function step1Instrumental(word: string, r1: number): string {
  const matched = trySuffix(word, STEP1_SUFFIXES)
  if (matched && inR1(word, r1, matched.length)) {
    const stripped = word.slice(0, -matched.length)
    if (endsWithDouble(stripped)) {
      return undoubleConsonant(stripped)
    }
  }
  return word
}

function step2CaseEndings(word: string, r1: number): string {
  const matched = trySuffix(word, STEP2_SUFFIXES)
  if (matched && inR1(word, r1, matched.length)) {
    const stripped = word.slice(0, -matched.length)
    if (stripped.endsWith('á')) {
      return `${stripped.slice(0, -1)}a`
    }
    if (stripped.endsWith('é')) {
      return `${stripped.slice(0, -1)}e`
    }
    return stripped
  }
  return word
}

function step3Emotive(word: string, r1: number): string {
  const matched = trySuffix(word, STEP3_SUFFIXES)
  if (matched && inR1(word, r1, matched.length)) {
    const stripped = word.slice(0, -matched.length)
    if (matched === 'én') return `${stripped}e`
    return `${stripped}a`
  }
  return word
}

function step4Comitative(word: string, r1: number): string {
  const matched = trySuffix(word, STEP4_SUFFIXES)
  if (matched && inR1(word, r1, matched.length)) {
    const stripped = word.slice(0, -matched.length)
    if (matched === 'ástul') return `${stripped}a`
    if (matched === 'éstül') return `${stripped}e`
    return stripped
  }
  return word
}

function step5LongVowel(word: string, r1: number): string {
  const matched = trySuffix(word, STEP5_SUFFIXES)
  if (matched && inR1(word, r1, matched.length)) {
    const stripped = word.slice(0, -matched.length)
    if (endsWithDouble(stripped)) {
      return undoubleConsonant(stripped)
    }
  }
  return word
}

function step6Possessive(word: string, r1: number): string {
  const matched = trySuffix(word, STEP6_SUFFIXES)
  if (matched && inR1(word, r1, matched.length)) {
    const stripped = word.slice(0, -matched.length)
    if (matched === 'áké' || matched === 'áéi') return `${stripped}a`
    if (matched === 'éké' || matched === 'ééi' || matched === 'éé') return `${stripped}e`
    return stripped
  }
  return word
}

function step7SingularPossessive(word: string, r1: number): string {
  const matched = trySuffix(word, STEP7_SUFFIXES)
  if (matched && inR1(word, r1, matched.length)) {
    const stripped = word.slice(0, -matched.length)
    if (matched === 'ájuk' || matched === 'ánk' || matched === 'ám' || matched === 'ád' || matched === 'á') {
      return `${stripped}a`
    }
    if (matched === 'éjük' || matched === 'énk' || matched === 'ém' || matched === 'éd' || matched === 'é') {
      return `${stripped}e`
    }
    return stripped
  }
  return word
}

function step8PluralPossessive(word: string, r1: number): string {
  const matched = trySuffix(word, STEP8_SUFFIXES)
  if (matched && inR1(word, r1, matched.length)) {
    const stripped = word.slice(0, -matched.length)
    if (
      matched === 'áitok' ||
      matched === 'áink' ||
      matched === 'áim' ||
      matched === 'áid' ||
      matched === 'áik' ||
      matched === 'ái'
    ) {
      return `${stripped}a`
    }
    if (
      matched === 'éitek' ||
      matched === 'éink' ||
      matched === 'éim' ||
      matched === 'éid' ||
      matched === 'éik' ||
      matched === 'éi'
    ) {
      return `${stripped}e`
    }
    return stripped
  }
  return word
}

function step9Plural(word: string, r1: number): string {
  const matched = trySuffix(word, STEP9_SUFFIXES)
  if (matched && inR1(word, r1, matched.length)) {
    const stripped = word.slice(0, -matched.length)
    if (matched === 'ák') return `${stripped}a`
    if (matched === 'ék') return `${stripped}e`
    return stripped
  }
  return word
}

function stem(word: string): string {
  if (word.length < 2) return word

  word = word.toLowerCase()

  const r1 = computeR1(word)

  word = step1Instrumental(word, r1)
  word = step2CaseEndings(word, r1)
  word = step3Emotive(word, r1)
  word = step4Comitative(word, r1)
  word = step5LongVowel(word, r1)
  word = step6Possessive(word, r1)
  word = step7SingularPossessive(word, r1)
  word = step8PluralPossessive(word, r1)
  word = step9Plural(word, r1)

  return word
}

const stopWords = new Set([
  'a',
  'abba',
  'abban',
  'abból',
  'addig',
  'ahhoz',
  'ahogy',
  'ahol',
  'aki',
  'akik',
  'akkor',
  'akár',
  'alapján',
  'alatt',
  'alatta',
  'alá',
  'amely',
  'amelyek',
  'amelyet',
  'amelyik',
  'amelynek',
  'ami',
  'amikor',
  'amit',
  'amíg',
  'annak',
  'annál',
  'arra',
  'arról',
  'attól',
  'az',
  'azok',
  'azokat',
  'azon',
  'azonban',
  'azt',
  'aztán',
  'azután',
  'azzal',
  'azért',
  'be',
  'belül',
  'benne',
  'bár',
  'csak',
  'de',
  'e',
  'eddig',
  'egy',
  'egyedül',
  'egyes',
  'egyetlen',
  'egyik',
  'egymás',
  'egyre',
  'egyéb',
  'együtt',
  'egész',
  'ehhez',
  'ekkor',
  'el',
  'ellen',
  'elég',
  'elő',
  'előbb',
  'először',
  'előtt',
  'előző',
  'engem',
  'ennek',
  'erre',
  'ez',
  'ezek',
  'ezen',
  'ezt',
  'ezután',
  'ezzel',
  'ezért',
  'fel',
  'felé',
  'ha',
  'hanem',
  'hiszen',
  'hogy',
  'hogyan',
  'hol',
  'holnap',
  'honnan',
  'hova',
  'hozzá',
  'ide',
  'igen',
  'ill',
  'illetve',
  'ilyen',
  'immár',
  'inkább',
  'is',
  'ismét',
  'itt',
  'jobban',
  'jól',
  'kell',
  'kellett',
  'keresztül',
  'kettő',
  'kevés',
  'ki',
  'kit',
  'közben',
  'közel',
  'közé',
  'között',
  'közül',
  'különben',
  'különböző',
  'le',
  'legalább',
  'legyen',
  'lehet',
  'lenne',
  'lenni',
  'lesz',
  'lett',
  'ma',
  'maga',
  'magát',
  'mai',
  'majd',
  'meg',
  'megint',
  'mellett',
  'mellé',
  'mely',
  'melyek',
  'melyik',
  'mennyi',
  'mert',
  'mi',
  'miatt',
  'mikor',
  'milyen',
  'mind',
  'minden',
  'mindenki',
  'mindent',
  'mindig',
  'minek',
  'minket',
  'mint',
  'mintha',
  'mit',
  'mivel',
  'miért',
  'mondta',
  'most',
  'már',
  'más',
  'másik',
  'második',
  'még',
  'mégis',
  'míg',
  'múlva',
  'nagy',
  'nagyon',
  'ne',
  'neked',
  'nekem',
  'neki',
  'nekik',
  'nekünk',
  'nem',
  'nincs',
  'nálunk',
  'néha',
  'néhány',
  'nélkül',
  'oda',
  'olyan',
  'onnan',
  'ott',
  'pedig',
  'persze',
  'rajta',
  'róla',
  'saját',
  'se',
  'sem',
  'semmi',
  'senki',
  'soha',
  'sok',
  'sokat',
  'sokkal',
  'során',
  'szemben',
  'szerint',
  'szinte',
  'számára',
  'sőt',
  'talán',
  'te',
  'tehát',
  'ti',
  'tovább',
  'további',
  'továbbá',
  'téged',
  'tőle',
  'ugyanis',
  'ugye',
  'után',
  'utána',
  'vagy',
  'vagyis',
  'vagyok',
  'vagyunk',
  'vajon',
  'valaki',
  'valami',
  'valamint',
  'való',
  'van',
  'vannak',
  'vele',
  'velem',
  'velünk',
  'vissza',
  'viszont',
  'volna',
  'volt',
  'voltak',
  'végre',
  'végül',
  'által',
  'általában',
  'át',
  'én',
  'és',
  'így',
  'ő',
  'ők',
  'őket',
  'őt',
])

export const hungarian: LanguageModule = {
  name: 'hungarian',
  stemmer: stem,
  stopWords,
  tokenizer: { splitPattern: /[^a-z0-9áéíóöőúüű]+/gi },
}
