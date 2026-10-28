import { registerLanguage } from '../../../languages/registry'
import type { LanguageModule } from '../../../types/language'
import type { AnyDocument, SchemaDefinition } from '../../../types/schema'
import type { SynonymRule } from '../../../types/synonyms'
import { seededRandom } from '../../filters/pattern/random-corpus'

export const INDEX = 'garage'
export const LANGUAGE_NAME = 'synonym-garage'
export const TEXT_FIELDS: readonly string[] = ['title', 'body']
export const SCHEMA: SchemaDefinition = { title: 'string', body: 'string' }
export const STOP_WORDS: ReadonlySet<string> = new Set(['the', 'of', 'and'])

export function stemOf(word: string): string {
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}

export const GARAGE_LANGUAGE: LanguageModule = {
  name: LANGUAGE_NAME,
  revision: '1',
  stemmer: stemOf,
  stopWords: new Set(STOP_WORDS),
}

export function registerGarageLanguage(): void {
  registerLanguage(GARAGE_LANGUAGE)
}

export function garageBootstrapModule(): string {
  const distPackage = new URL('../../../../dist/index.mjs', import.meta.url)
  const source = `import { registerLanguage } from ${JSON.stringify(distPackage.href)}
registerLanguage({ name: ${JSON.stringify(LANGUAGE_NAME)}, revision: '1', stemmer: ${stemOf.toString()}, stopWords: new Set(${JSON.stringify([...STOP_WORDS])}) })`
  return `data:text/javascript,${encodeURIComponent(source)}`
}

const CONSONANTS = 'bcdfghjklmnp'

export const CODE_WORDS: readonly string[] = Array.from(
  { length: 64 },
  (_, at) => `q${CONSONANTS[Math.floor(at / CONSONANTS.length)]}${CONSONANTS[at % CONSONANTS.length]}`,
)

const FAMILY_WORDS = [
  'car',
  'auto',
  'automobile',
  'cart',
  'truck',
  'van',
  'vehicle',
  'film',
  'movie',
  'picture',
  'photo',
  'big',
  'large',
  'huge',
  'giant',
  'fast',
  'quick',
  'rapid',
  'swift',
]
const FILLER = ['road', 'river', 'stone', 'city', 'night', 'house', 'light', 'green', 'cat', 'cast', 'rock']
const VOCABULARY: readonly string[] = [...FAMILY_WORDS, ...FILLER].flatMap(word => [word, `${word}s`])

export const FIRST_RULES: SynonymRule[] = [
  { words: ['car', 'auto', 'automobile', 'cart'] },
  { word: 'vehicle', synonyms: ['car', 'truck', 'Vans'] },
  { words: ['film', 'movie', 'Movies'] },
  { word: 'picture', synonyms: ['film', 'photo'] },
  { words: ['big', 'large', 'huge', 'giant', ...CODE_WORDS.slice(0, 40)] },
  { words: ['giant', ...CODE_WORDS.slice(30)] },
  { words: ['fast', 'quick'] },
  { words: ['quick', 'rapid', 'swift'] },
]

export const SECOND_RULES: SynonymRule[] = [
  { words: ['road', 'river'] },
  { word: 'stone', synonyms: ['rock', 'cast'] },
  { words: ['fast', 'rapid'] },
  { words: ['cat', ...CODE_WORDS.slice(10, 70)] },
]

export function garageCorpus(count: number, seed: number, idPrefix = 'car'): AnyDocument[] {
  const random = seededRandom(seed)
  const word = (): string =>
    random() < 0.2
      ? CODE_WORDS[Math.floor(random() * CODE_WORDS.length)]
      : VOCABULARY[Math.floor(random() * VOCABULARY.length)]
  const words = (least: number, most: number): string =>
    Array.from({ length: least + Math.floor(random() * (most - least + 1)) }, word).join(' ')
  return Array.from({ length: count }, (_, at) => ({
    id: `${idPrefix}${String(at).padStart(5, '0')}`,
    title: words(1, 4),
    body: words(3, 8),
  }))
}

export const PROBE_TERMS: readonly string[] = [
  'car',
  'cars',
  'vehicle',
  'automobile',
  'truck',
  'vans',
  'movie',
  'film',
  'picture',
  'photo',
  'big',
  'giant',
  'huge giant',
  'giant huge quick',
  'fast',
  'rapid',
  'quick swift',
  'the car of the road',
  'road stone',
  'cat',
  'cats film',
  CODE_WORDS[63],
  `${CODE_WORDS[5]} giant`,
  'nothing',
]
