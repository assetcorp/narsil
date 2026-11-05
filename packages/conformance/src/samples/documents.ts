const COLOURS = ['red', 'green', 'blue', 'black', 'white'] as const
const CATEGORIES = ['tools', 'garden', 'kitchen'] as const
const NOUNS = ['hammer', 'kettle', 'trowel', 'ladder', 'saucepan', 'shears', 'lantern', 'bucket'] as const
const ADJECTIVES = ['sturdy', 'folding', 'enamelled', 'cordless', 'running', 'polished', 'heavy', 'lighter'] as const
const SAMPLE_VECTOR_SEED = 20_261_105
const SAMPLE_VECTOR_DIMENSION = 8

function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 4_294_967_296
  }
}

export const PRODUCT_SCHEMA = {
  title: 'string',
  tags: 'string[]',
  sku: 'verbatim:sortable',
  price: 'number',
  sizes: 'number[]',
  inStock: 'boolean',
  category: 'enum',
  colours: 'enum[]',
  location: 'geopoint',
  code: 'string:pattern',
  description: 'string:partial',
  embedding: `vector[${SAMPLE_VECTOR_DIMENSION}]`,
} as const

export const NOTE_SCHEMA = {
  title: 'string',
  body: 'string',
  pinned: 'boolean',
  embedding: `vector[${SAMPLE_VECTOR_DIMENSION}]`,
} as const

function vectorOf(random: () => number): number[] {
  return Array.from({ length: SAMPLE_VECTOR_DIMENSION }, () => Math.fround(random() * 2 - 1))
}

export function productDocuments(count: number): Array<Record<string, unknown>> {
  const random = seededRandom(SAMPLE_VECTOR_SEED)
  return Array.from({ length: count }, (_, at) => {
    const noun = NOUNS[at % NOUNS.length]
    const adjective = ADJECTIVES[(at * 3) % ADJECTIVES.length]
    return {
      id: `product-${String(at).padStart(3, '0')}`,
      title: `${adjective} ${noun} number ${at}`,
      tags: [noun, adjective, at % 2 === 0 ? 'stocked items' : 'ordered items'],
      sku: `SKU-${(at * 7919) % 10_007}`,
      price: Math.round(random() * 10_000) / 100,
      sizes: at % 4 === 0 ? [] : [at % 5, (at % 7) + 0.5],
      inStock: at % 3 !== 0,
      category: CATEGORIES[at % CATEGORIES.length],
      colours: [COLOURS[at % COLOURS.length], COLOURS[(at + 2) % COLOURS.length]],
      location: { lat: -45 + ((at * 13) % 90), lon: -170 + ((at * 37) % 340) },
      code: `ZX-${at}-${noun.toUpperCase()}`,
      description: `The ${adjective} ${noun} keeps running for years, and buyers keep running back for more ${noun}s.`,
      embedding: vectorOf(random),
      notes: {
        added: new Date(Date.UTC(2026, at % 12, (at % 27) + 1, 8, 30, 15, at)),
        checksum: Uint8Array.of(at, 255 - at, 7),
        $source: 'catalogue',
        ratio: at % 9 === 0 ? -0 : at / 8,
      },
    }
  })
}

export function noteDocuments(count: number): Array<Record<string, unknown>> {
  const random = seededRandom(SAMPLE_VECTOR_SEED + 1)
  return Array.from({ length: count }, (_, at) => ({
    id: `note-${String(at).padStart(3, '0')}`,
    title: `Note ${at} about the ${NOUNS[at % NOUNS.length]}`,
    body: `Remember that the ${ADJECTIVES[at % ADJECTIVES.length]} ${NOUNS[(at + 1) % NOUNS.length]} goes back on shelf ${at % 6}.`,
    pinned: at % 4 === 0,
    embedding: vectorOf(random),
  }))
}
