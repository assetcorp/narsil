import { type AnyDocument, createNarsil, type Narsil } from '../src'

const SCALES = [1_000, 10_000, 50_000]
const VECTOR_DIMENSION = 384
const SEED = 42

const CATEGORIES = ['engineering', 'research', 'operations', 'analytics', 'infrastructure', 'security']

function mulberry32(seed: number): () => number {
  let s = seed | 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomSentence(rand: () => number, wordCount: number): string {
  const words: string[] = []
  for (let i = 0; i < wordCount; i++) {
    words.push(`w${Math.floor(rand() * 4096).toString(36)}`)
  }
  return words.join(' ')
}

function generateTextDocs(count: number, seed: number): AnyDocument[] {
  const rand = mulberry32(seed)
  const docs: AnyDocument[] = []
  for (let i = 0; i < count; i++) {
    docs.push({
      title: randomSentence(rand, 3 + Math.floor(rand() * 10)),
      body: randomSentence(rand, 30 + Math.floor(rand() * 140)),
      score: Math.floor(rand() * 100),
      category: CATEGORIES[Math.floor(rand() * CATEGORIES.length)],
    })
  }
  return docs
}

function generateVectorDocs(count: number, dimension: number, seed: number): AnyDocument[] {
  const rand = mulberry32(seed)
  const docs: AnyDocument[] = []
  for (let i = 0; i < count; i++) {
    const embedding = new Array<number>(dimension)
    let magnitude = 0
    for (let j = 0; j < dimension; j++) {
      const g = (rand() + rand() + rand() - 1.5) * 2
      embedding[j] = g
      magnitude += g * g
    }
    magnitude = Math.sqrt(magnitude)
    if (magnitude > 0) {
      for (let j = 0; j < dimension; j++) embedding[j] /= magnitude
    }
    docs.push({ title: randomSentence(rand, 3 + Math.floor(rand() * 10)), embedding })
  }
  return docs
}

function tryGc(): void {
  if (typeof globalThis.gc === 'function') globalThis.gc()
}

async function settleHeap(): Promise<number> {
  tryGc()
  tryGc()
  await new Promise(resolve => setTimeout(resolve, 100))
  return process.memoryUsage().heapUsed
}

function formatRatio(estimatedBytes: number, heapDelta: number): string {
  return heapDelta > 0 ? (estimatedBytes / heapDelta).toFixed(2) : 'n/a'
}

async function measureText(scale: number): Promise<void> {
  let instance: Narsil | undefined
  try {
    const baselineHeap = await settleHeap()
    instance = await createNarsil()
    await instance.createIndex('bench', {
      schema: { title: 'string', body: 'string', score: 'number', category: 'enum' },
      language: 'english',
      trackPositions: false,
    })
    await instance.insertBatch('bench', generateTextDocs(scale, SEED), { skipClone: true })

    const afterHeap = await settleHeap()
    const heapDelta = Math.max(0, afterHeap - baselineHeap)
    const estimatedBytes = instance.getStats('bench').estimatedMemoryBytes
    console.log(
      `  text   ${scale.toLocaleString().padStart(8)}: heap delta ${heapDelta.toLocaleString()} bytes, estimated ${estimatedBytes.toLocaleString()} bytes, ratio ${formatRatio(estimatedBytes, heapDelta)}`,
    )
  } finally {
    if (instance) await instance.shutdown()
  }
}

async function measureVector(scale: number): Promise<void> {
  let instance: Narsil | undefined
  try {
    const baselineHeap = await settleHeap()
    instance = await createNarsil()
    await instance.createIndex('bench', {
      schema: { title: 'string', embedding: `vector[${VECTOR_DIMENSION}]` },
      language: 'english',
      trackPositions: false,
    })
    await instance.insertBatch('bench', generateVectorDocs(scale, VECTOR_DIMENSION, SEED), { skipClone: true })

    const afterHeap = await settleHeap()
    const heapDelta = Math.max(0, afterHeap - baselineHeap)
    const estimatedBytes = instance.getStats('bench').estimatedMemoryBytes
    console.log(
      `  vector ${scale.toLocaleString().padStart(8)}: heap delta ${heapDelta.toLocaleString()} bytes, estimated ${estimatedBytes.toLocaleString()} bytes, ratio ${formatRatio(estimatedBytes, heapDelta)}`,
    )
  } finally {
    if (instance) await instance.shutdown()
  }
}

async function main(): Promise<void> {
  if (typeof globalThis.gc !== 'function') {
    console.log('warning: run with --expose-gc for accurate heap measurements\n')
  }
  console.log(
    `Memory estimate accuracy (getStats().estimatedMemoryBytes vs heap delta), ${VECTOR_DIMENSION}-dim vectors\n`,
  )
  for (const scale of SCALES) {
    await measureText(scale)
    await measureVector(scale)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
