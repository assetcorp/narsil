import type { AnyDocument, SchemaDefinition } from '../../../types/schema'
import { seededRandom } from '../../filters/pattern/random-corpus'

export const INDEX = 'products'
export const COMMON_TERM = 'item'

export const SCHEMA: SchemaDefinition = {
  body: 'string',
  title: 'string',
  name: 'string:sortable',
  brand: 'verbatim',
  category: 'enum',
  price: 'number',
  rating: 'number',
  inStock: 'boolean',
  tags: 'string[]',
  sizes: 'number[]',
  flags: 'boolean[]',
  colours: 'enum[]',
  location: 'geopoint',
  dims: { width: 'number', label: 'verbatim' },
}

export const BRANDS = ['Acme', 'acme', 'Zeta', 'Ωmega', 'Straße', '']
export const CATEGORIES = ['tools', 'garden', 'kitchen', 'Tools']
export const TAGS = ['sale', 'new', 'eco', 'Sale', 'limited', '']
export const COLOURS = ['red', 'green', 'blue', 'Red']
export const NAMES = ['apple', 'Apple', 'Banana', 'FUSS', 'Fuß', 'fuss', 'Zebra', 'école', 'doc-10', 'doc-2', '']
export const PRICES = [0, -5, 1, 9.99, 10, 10.5, 99, 1e9, -0.25]
export const CITIES: Array<{ lat: number; lon: number }> = [
  { lat: 5.6037, lon: -0.187 },
  { lat: 6.6885, lon: -1.6244 },
  { lat: 51.5072, lon: -0.1276 },
  { lat: -33.8688, lon: 151.2093 },
  { lat: -18.1416, lon: 178.4419 },
  { lat: -17.7134, lon: -179.9 },
  { lat: 89.9, lon: 10 },
  { lat: 0, lon: 0 },
]

type Random = () => number

function pick<T>(random: Random, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]
}

function listOf<T>(random: Random, items: readonly T[], maximum: number): T[] {
  return Array.from({ length: Math.floor(random() * (maximum + 1)) }, () => pick(random, items))
}

function maybe(random: Random, setter: () => void, absentShare = 0.15): void {
  if (random() >= absentShare) setter()
}

export function productCorpus(count: number, seed: number): AnyDocument[] {
  const random = seededRandom(seed)
  return Array.from({ length: count }, (_, at) => {
    const document: AnyDocument = { id: `p${String(at).padStart(5, '0')}`, body: COMMON_TERM }
    maybe(random, () => {
      document.title = `${pick(random, ['Hammer', 'Rake', 'Pan', 'Kettle'])} ${pick(random, ['pro', 'mini', 'eco'])}`
    })
    maybe(random, () => {
      document.name = pick(random, NAMES)
    })
    maybe(random, () => {
      document.brand = pick(random, BRANDS)
    })
    maybe(random, () => {
      document.category = pick(random, CATEGORIES)
    })
    maybe(random, () => {
      document.price = pick(random, PRICES)
    })
    maybe(random, () => {
      document.rating = Math.round(random() * 50) / 10
    })
    maybe(random, () => {
      document.inStock = random() < 0.5
    })
    maybe(random, () => {
      document.tags = listOf(random, TAGS, 3)
    })
    maybe(random, () => {
      document.sizes = listOf(random, [1, 2, 3, 2.5, -1, 0], 3)
    })
    maybe(random, () => {
      document.flags = listOf(random, [true, false], 2)
    })
    maybe(random, () => {
      document.colours = listOf(random, COLOURS, 3)
    })
    maybe(random, () => {
      const city = pick(random, CITIES)
      document.location = {
        lat: city.lat + (random() - 0.5) / 10,
        lon: Math.max(-180, Math.min(180, city.lon + (random() - 0.5) / 10)),
      }
    })
    maybe(random, () => {
      document.dims = {}
      maybe(random, () => {
        ;(document.dims as Record<string, unknown>).width = pick(random, PRICES)
      })
      maybe(random, () => {
        ;(document.dims as Record<string, unknown>).label = pick(random, BRANDS)
      })
    })
    if (random() < 0.05) document.price = null
    if (random() < 0.05) document.tags = null
    return document
  })
}
