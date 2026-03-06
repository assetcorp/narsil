import type { LanguageModule } from '../types/language'

const ACCENT_MAP: Record<string, string> = {
  ά: 'α',
  έ: 'ε',
  ή: 'η',
  ί: 'ι',
  ό: 'ο',
  ύ: 'υ',
  ώ: 'ω',
  ΐ: 'ϊ',
  ΰ: 'ϋ',
}

function normalizeGreek(word: string): string {
  let result = ''
  for (const ch of word) {
    const mapped = ACCENT_MAP[ch]
    if (mapped) {
      result += mapped
    } else if (ch === 'ς') {
      result += 'σ'
    } else {
      result += ch
    }
  }
  return result
}

function endsWith(word: string, suffix: string): boolean {
  return word.length >= suffix.length && word.endsWith(suffix)
}

function stripSuffix(word: string, suffix: string): string {
  return word.slice(0, word.length - suffix.length)
}

function endsWithAny(word: string, suffixes: string[]): string | null {
  for (const s of suffixes) {
    if (endsWith(word, s)) return s
  }
  return null
}

function stepGroup1(word: string): string {
  const suffixes = [
    'φαγια',
    'φαγιου',
    'φαγιων',
    'σκαγια',
    'σκαγιου',
    'σκαγιων',
    'ολογιου',
    'ολογια',
    'ολογιων',
    'σογιου',
    'σογια',
    'σογιων',
    'τατογια',
    'τατογιου',
    'τατογιων',
    'κρεασ',
    'κρεατοσ',
    'κρεατα',
    'κρεατων',
    'περασ',
    'περατοσ',
    'περατα',
    'περατων',
    'περατη',
    'τερασ',
    'τερατοσ',
    'τερατα',
    'τερατων',
    'φωσ',
    'φωτοσ',
    'φωτα',
    'φωτων',
    'καθεστωσ',
    'καθεστωτοσ',
    'καθεστωτα',
    'καθεστωτων',
    'γεγονοσ',
    'γεγονοτοσ',
    'γεγονοτα',
    'γεγονοτων',
  ]

  const match = endsWithAny(word, suffixes)
  if (match) return stripSuffix(word, match)
  return word
}

function stepAdjectival(word: string): string {
  const longSuffixes = ['ικοτητεσ', 'ικοτητα', 'ικοτητων', 'ικεσ', 'ικοι', 'ικων', 'ικου', 'ικησ', 'ικο', 'ικα', 'ικη']

  const match = endsWithAny(word, longSuffixes)
  if (match && word.length - match.length >= 2) {
    return stripSuffix(word, match)
  }

  const adjectiveSuffixes = [
    'ωδεσ',
    'ωδησ',
    'ωδη',
    'ωδων',
    'ινεσ',
    'ινοσ',
    'ινου',
    'ινο',
    'ινη',
    'ινα',
    'ινων',
    'ενοσ',
    'ενου',
    'ενα',
    'ενη',
    'ενεσ',
    'ενων',
    'αλεσ',
    'αλησ',
    'αλη',
    'αλων',
    'αριεσ',
    'αριοσ',
    'αριου',
    'αριο',
    'αρια',
    'αριων',
    'ωτεσ',
    'ωτοσ',
    'ωτου',
    'ωτο',
    'ωτη',
    'ωτα',
    'ωτων',
  ]

  const adjMatch = endsWithAny(word, adjectiveSuffixes)
  if (adjMatch && word.length - adjMatch.length >= 2) {
    return stripSuffix(word, adjMatch)
  }

  return word
}

function stepVerb(word: string): string {
  const verbSuffixes = [
    'ηθηκατε',
    'ηθηκαμε',
    'ουσατε',
    'ουσαμε',
    'ιουνται',
    'ησατε',
    'ησαμε',
    'ηκατε',
    'ηκαμε',
    'ουνται',
    'ηθηκα',
    'ηθηκε',
    'ιεστε',
    'ιεμαι',
    'αγατε',
    'αγαμε',
    'ησουν',
    'ουσαν',
    'ιεσαι',
    'ιεται',
    'ιομαι',
    'ιουμε',
    'ωντασ',
    'οντασ',
    'ουμε',
    'ηθει',
    'ηστε',
    'ησου',
    'ουσε',
    'ησει',
    'αγει',
    'ησεσ',
    'ησεισ',
    'ηκεσ',
    'ηκεισ',
    'ουσεσ',
    'ηθω',
    'ουνε',
    'ησαν',
    'ηκαν',
    'αγα',
    'ησα',
    'ησε',
    'ηκα',
    'ηκε',
    'αμε',
    'ατε',
    'ουν',
    'αει',
    'εισ',
    'ουσ',
    'ησ',
    'αν',
    'ασ',
    'εσ',
    'ηω',
    'ει',
    'αω',
    'ω',
  ]

  const match = endsWithAny(word, verbSuffixes)
  if (match && word.length - match.length >= 2) {
    return stripSuffix(word, match)
  }
  return word
}

function stepNounCase(word: string): string {
  const nounSuffixes = [
    'ματων',
    'ματα',
    'ματοσ',
    'ατων',
    'ατα',
    'ατοσ',
    'ιων',
    'ιασ',
    'ιεσ',
    'εων',
    'ων',
    'ου',
    'ησ',
    'εσ',
    'οσ',
    'ασ',
    'ισ',
    'υσ',
    'α',
    'ε',
    'η',
    'ι',
    'ο',
    'υ',
  ]

  const match = endsWithAny(word, nounSuffixes)
  if (match && word.length - match.length >= 2) {
    return stripSuffix(word, match)
  }
  return word
}

function stepDiminutive(word: string): string {
  const diminutiveSuffixes = [
    'ιδια',
    'ιδιου',
    'ιδιων',
    'ιδιο',
    'ακια',
    'ακιου',
    'ακιων',
    'ακι',
    'ιτσα',
    'ιτσασ',
    'ιτσεσ',
    'ιτσων',
    'ουλα',
    'ουλασ',
    'ουλεσ',
    'ουλων',
    'ουλι',
    'ουλιου',
    'ουλιων',
    'ουδα',
    'ουδασ',
    'ουδεσ',
    'ουδων',
    'αρα',
    'αρασ',
    'αρεσ',
    'αρων',
  ]

  const match = endsWithAny(word, diminutiveSuffixes)
  if (match && word.length - match.length >= 2) {
    return stripSuffix(word, match)
  }
  return word
}

function stem(word: string): string {
  word = normalizeGreek(word.toLowerCase())

  if (word.length < 3) return word

  word = stepGroup1(word)
  word = stepAdjectival(word)
  word = stepDiminutive(word)
  word = stepVerb(word)
  word = stepNounCase(word)

  if (word.length < 2) return word

  return word
}

const stopWords = new Set([
  'ο',
  'η',
  'το',
  'οι',
  'τα',
  'τον',
  'την',
  'του',
  'της',
  'των',
  'τους',
  'τις',
  'στο',
  'στη',
  'στον',
  'στην',
  'εγω',
  'εσυ',
  'αυτοσ',
  'αυτη',
  'αυτο',
  'εμεισ',
  'εσεισ',
  'αυτοι',
  'αυτεσ',
  'αυτα',
  'αυτων',
  'αυτουσ',
  'μου',
  'σου',
  'μασ',
  'σασ',
  'σε',
  'απο',
  'με',
  'για',
  'προσ',
  'κατα',
  'μετα',
  'μεχρι',
  'χωρισ',
  'παρα',
  'αντι',
  'και',
  'η',
  'αλλα',
  'ουτε',
  'ενω',
  'αν',
  'εαν',
  'οταν',
  'επειδη',
  'αφου',
  'ωστε',
  'ωστοσο',
  'ομωσ',
  'ειναι',
  'εχει',
  'ηταν',
  'ειχε',
  'θα',
  'να',
  'εχω',
  'εχουμε',
  'εχετε',
  'εχουν',
  'πολυ',
  'πιο',
  'πωσ',
  'που',
  'εδω',
  'εκει',
  'τωρα',
  'παντα',
  'ποτε',
  'παλι',
  'δεν',
  'μη',
  'μην',
  'ωσ',
  'κι',
  'αλλιωσ',
  'δηλαδη',
  'οπωσ',
  'οτι',
  'οσο',
  'μα',
  'κ',
  'δε',
  'τοτε',
  'ισωσ',
  'επι',
  'εκεινοσ',
  'εκεινη',
  'εκεινο',
  'εκεινοι',
  'εκεινεσ',
  'εκεινα',
  'εκεινων',
  'εκεινουσ',
  'ποιοσ',
  'ποια',
  'ποιο',
  'ποιοι',
  'ποιεσ',
  'ποιων',
  'ποιουσ',
  'ειμαι',
  'εισαι',
  'ειμαστε',
  'ειστε',
])

export const greek: LanguageModule = {
  name: 'greek',
  stemmer: stem,
  stopWords,
  tokenizer: {
    splitPattern: /[^\u0370-\u03FFa-z0-9]+/gi,
    normalizeDiacritics: true,
    minTokenLength: 2,
  },
}
