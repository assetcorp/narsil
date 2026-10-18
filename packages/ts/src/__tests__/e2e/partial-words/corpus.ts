import { registerLanguage } from '../../../languages/registry'
import type { LanguageModule } from '../../../types/language'
import type { AnyDocument, SchemaDefinition } from '../../../types/schema'
import { seededRandom } from '../../filters/pattern/random-corpus'

export const INDEX = 'workshop'
export const LANGUAGE_NAME = 'partial-word-workshop'
export const TITLE = 'title'
export const BODY = 'body'
export const PARTIAL_FIELDS: readonly string[] = [TITLE]
export const TEXT_FIELDS: readonly string[] = [TITLE, BODY]

export const SCHEMA: SchemaDefinition = { title: 'string:partial', body: 'string' }

export function stemOf(word: string): string {
  if (word.length > 6 && word.endsWith('ing')) return word.slice(0, -3)
  if (word.length > 4 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}

export const WORKSHOP_LANGUAGE: LanguageModule = {
  name: LANGUAGE_NAME,
  revision: '1',
  stemmer: stemOf,
  stopWords: new Set(),
}

export function registerWorkshopLanguage(): void {
  registerLanguage(WORKSHOP_LANGUAGE)
}

export function workshopBootstrapModule(): string {
  const distPackage = new URL('../../../../dist/index.mjs', import.meta.url)
  const source = `import { registerLanguage } from ${JSON.stringify(distPackage.href)}
registerLanguage({ name: ${JSON.stringify(LANGUAGE_NAME)}, revision: '1', stemmer: ${stemOf.toString()}, stopWords: new Set() })`
  return `data:text/javascript,${encodeURIComponent(source)}`
}

const ROOTS = ['proof', 'water', 'fire', 'rain', 'wind', 'coat', 'light', 'house', 'boat', 'storm', 'shield', 'mill']
const COMPOUNDS = [
  'waterproof',
  'fireproof',
  'rainproof',
  'windproof',
  'raincoat',
  'overcoat',
  'lighthouse',
  'houseboat',
  'stormlight',
  'firelight',
  'windshield',
  'windmill',
  'watermill',
  'millstone',
  'firestone',
  'rainwater',
  'proofreader',
]
const FILLER = ['bench', 'table', 'paint', 'brush', 'chair', 'lamp']

export const TITLE_WORDS: readonly string[] = [...ROOTS, ...COMPOUNDS].flatMap(word => [word, `${word}s`, `${word}ing`])
const BODY_WORDS: readonly string[] = [...TITLE_WORDS, ...FILLER]

export function workshopCorpus(count: number, seed: number, idPrefix = 'item'): AnyDocument[] {
  const random = seededRandom(seed)
  const words = (pool: readonly string[], least: number, most: number): string =>
    Array.from(
      { length: least + Math.floor(random() * (most - least + 1)) },
      () => pool[Math.floor(random() * pool.length)],
    ).join(' ')
  return Array.from({ length: count }, (_, at) => ({
    id: `${idPrefix}${String(at).padStart(5, '0')}`,
    title: words(TITLE_WORDS, 1, 4),
    body: words(BODY_WORDS, 3, 7),
  }))
}

export const PROBE_TERMS: readonly string[] = [
  'proof',
  'proofing',
  'proofs',
  'water',
  'ater',
  'coats',
  'coat',
  'incoat',
  'light house',
  'rain coat',
  'fire proof stone',
  'mil',
  'oof',
  'pr',
  'stone wat',
  'shields',
  'overcoat',
  'boat house light',
  'zzz',
  'reader',
  'houses',
  'ill',
]
