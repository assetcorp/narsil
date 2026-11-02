export const VOCABULARY = [
  'amberlit',
  'borvane',
  'cindrel',
  'dovrask',
  'elmquor',
  'fennark',
  'gostrel',
  'harvund',
  'ilmatra',
  'jorvik',
  'kestral',
  'lomvard',
  'mirdal',
  'norvhel',
  'oskaru',
  'pelvark',
  'quillon',
  'rostvan',
  'selvane',
  'trevak',
  'ulmord',
  'wexlorn',
  'xandrel',
  'yorvath',
  'zorbex',
  'brakmo',
  'crundle',
  'drimvar',
  'esklar',
  'fyndral',
] as const

export const KEYWORD_TERMS = ['zorbex', 'quillon', 'trevak', 'mirdal', 'oskaru'] as const
export const HYBRID_TERM = 'fennark'
export const WORDS_PER_TITLE = 6
export const DIMENSION = 64
export const DOCUMENT_COUNT = 5_000
export const QUERY_COUNT = 20
export const NEIGHBOURS = 10
export const FIRST_YEAR = 1950
export const YEAR_SPAN = 76
export const CORPUS_SEED = 0x5eed_1234
export const QUERY_SEED = 0x5eed_9876

export type CorpusDocument = {
  id: string
  title: string
  year: number
  embedding: number[]
}

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

function float32(value: number): number {
  return Math.fround(value)
}

export function randomVector(random: () => number): number[] {
  const vector: number[] = []
  for (let component = 0; component < DIMENSION; component++) vector.push(float32(random() * 2 - 1))
  return vector
}

export function documentId(index: number): string {
  return `doc-${String(index).padStart(5, '0')}`
}

export function corpus(count = DOCUMENT_COUNT, seed = CORPUS_SEED): CorpusDocument[] {
  const random = seededRandom(seed)
  const documents: CorpusDocument[] = []
  for (let index = 0; index < count; index++) {
    const words: string[] = []
    for (let word = 0; word < WORDS_PER_TITLE; word++) {
      words.push(VOCABULARY[Math.floor(random() * VOCABULARY.length)] ?? VOCABULARY[0])
    }
    documents.push({
      id: documentId(index),
      title: words.join(' '),
      year: FIRST_YEAR + Math.floor(random() * YEAR_SPAN),
      embedding: randomVector(random),
    })
  }
  return documents
}

export function queryVectors(count = QUERY_COUNT, seed = QUERY_SEED): number[][] {
  const random = seededRandom(seed)
  return Array.from({ length: count }, () => randomVector(random))
}
