const FIRST_COMBINING_MARK = 0x0300
const LAST_COMBINING_MARK = 0x036f
const LCG_MULTIPLIER = 1_103_515_245
const LCG_INCREMENT = 12_345
const LCG_MODULUS = 2 ** 31
const LCG_LOW_BITS = 2 ** 16

export const HAUSA_HOOKED_LETTERS: Readonly<Record<string, string>> = { ɓ: 'b', ɗ: 'd', ƙ: 'k', ƴ: 'y' }

export const YORUBA_WORDS = [
  'ọkọ',
  'ọkọ̀',
  'oko',
  'okò',
  'ilé',
  'ile',
  'ìlú',
  'ilu',
  'ọmọ',
  'omo',
  'ẹja',
  'eja',
  'ọjà',
  'oja',
  'àgbà',
  'agba',
  'ṣẹ́gun',
  'segun',
  'kékeré',
  'kekere',
  'ọ̀rẹ́',
  'ore',
  'ìwé',
  'iwe',
] as const

export const YORUBA_QUERY_WORDS = ['oko', 'ile', 'ilu', 'omo', 'eja', 'oja', 'agba', 'segun', 'kekere', 'ore', 'iwe']

export interface WordDocument {
  id: string
  body: string
}

export function foldOracle(word: string, letters: Readonly<Record<string, string>> = {}): string {
  let folded = ''
  for (const point of word.normalize('NFD')) {
    const code = point.codePointAt(0) ?? 0
    if (code >= FIRST_COMBINING_MARK && code <= LAST_COMBINING_MARK) continue
    folded += letters[point] ?? point
  }
  return folded
}

export function editDistance(left: string, right: string): number {
  const a = [...left]
  const b = [...right]
  let previous = Array.from({ length: b.length + 1 }, (_, at) => at)
  for (let row = 1; row <= a.length; row++) {
    const current = [row]
    for (let column = 1; column <= b.length; column++) {
      const substitution = previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1)
      current.push(Math.min(previous[column] + 1, current[column - 1] + 1, substitution))
    }
    previous = current
  }
  return previous[b.length]
}

export function sharesLeadingPoints(candidate: string, query: string, count: number): boolean {
  const kept = [...query].slice(0, count)
  return [...candidate].slice(0, kept.length).join('') === kept.join('')
}

export function idsWithWord(documents: readonly WordDocument[], matches: (word: string) => boolean): string[] {
  return documents
    .filter(document => document.body.split(' ').some(matches))
    .map(document => document.id)
    .sort()
}

export function generatedDocuments(count: number, words: readonly string[], seed: number): WordDocument[] {
  let state = seed
  const next = (): number => {
    state = (state * LCG_MULTIPLIER + LCG_INCREMENT) % LCG_MODULUS
    return Math.floor(state / LCG_LOW_BITS)
  }
  return Array.from({ length: count }, (_, at) => {
    const length = 2 + (next() % 3)
    const body = Array.from({ length }, () => words[next() % words.length]).join(' ')
    return { id: `doc-${String(at).padStart(5, '0')}`, body }
  })
}

export function wordSpans(text: string, matches: (word: string) => boolean): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = []
  let start = 0
  for (const word of text.split(' ')) {
    if (matches(word)) spans.push({ start, end: start + word.length })
    start += word.length + 1
  }
  return spans
}
