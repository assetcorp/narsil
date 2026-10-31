import { registerLanguage } from '../../../languages/registry'
import type { AnyDocument, SchemaDefinition } from '../../../types/schema'
import { seededRandom } from '../../filters/pattern/random-corpus'

export const INDEX = 'pantry'
export const LANGUAGE_NAME = 'phrase-pantry'
export const TEXT_FIELDS: readonly string[] = ['title', 'body', 'tags']
export const SCHEMA: SchemaDefinition = { title: 'string', body: 'string', tags: 'string[]', shelf: 'number' }
export const STOP_WORDS: ReadonlySet<string> = new Set(['the', 'of', 'and'])

export function stemOf(word: string): string {
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}

export function registerPantryLanguage(): void {
  registerLanguage({ name: LANGUAGE_NAME, revision: '1', stemmer: stemOf, stopWords: new Set(STOP_WORDS) })
}

export function pantryBootstrapModule(): string {
  const distPackage = new URL('../../../../dist/index.mjs', import.meta.url)
  const source = `import { registerLanguage } from ${JSON.stringify(distPackage.href)}
registerLanguage({ name: ${JSON.stringify(LANGUAGE_NAME)}, revision: '1', stemmer: ${stemOf.toString()}, stopWords: new Set(${JSON.stringify([...STOP_WORDS])}) })`
  return `data:text/javascript,${encodeURIComponent(source)}`
}

const WORDS = ['olive', 'oil', 'oils', 'pasta', 'fresh', 'state', 'art', 'bread', 'the', 'of', 'and', 'salt']
const SEEDED_RUNS = [
  'olive oil',
  'olive oils',
  'state of the art',
  'fresh pasta',
  'oil oil oil',
  'oil olive',
  'state art',
]

export const PROBE_TERMS: readonly string[] = [
  '"olive oil"',
  '"olive oils"',
  '"oil olive"',
  '"state of the art"',
  '"state art"',
  '"the state of the art of"',
  '"olive oil" pasta',
  'pasta "olive oil"',
  '"olive oil" "fresh pasta"',
  '"olive oil" "olive oil"',
  '"oil oil"',
  '"pasta"',
  '“olive oil” bread',
  '„olive oil“ bread',
  '”olive oil” bread',
  'bread "olive oil',
  '"" bread',
  '"the of" bread',
  '"nowhere olive" bread',
  'olive oil',
]

export const QUERY_SHAPES: ReadonlyArray<Record<string, unknown>> = [
  {},
  { fields: ['body'] },
  { fields: ['tags'] },
  { boost: { title: 2.5, tags: 0.5 } },
  { termMatch: 'all' },
  { termMatch: 1 },
]

export function pantryCorpus(count: number, seed: number, idPrefix = 'jar'): AnyDocument[] {
  const random = seededRandom(seed)
  const pick = <T>(pool: readonly T[]): T => pool[Math.floor(random() * pool.length)]
  const text = (parts: number): string =>
    Array.from({ length: parts }, () => (random() < 0.35 ? pick(SEEDED_RUNS) : pick(WORDS))).join(' ')
  return Array.from({ length: count }, (_, at) => ({
    id: `${idPrefix}-${at}`,
    title: text(1 + Math.floor(random() * 4)),
    body: text(3 + Math.floor(random() * 16)),
    tags: Array.from({ length: Math.floor(random() * 4) }, () => (random() < 0.5 ? pick(WORDS) : text(2))),
    shelf: at % 5,
  }))
}
