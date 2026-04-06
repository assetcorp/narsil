import { createNarsil } from '@delali/narsil'
import { generateVectorDocuments } from './data'
import { fmt } from './stats'

const DIMENSION = 1536
const SCALE = 10_000
const SEED = 42

async function main() {
  console.log(`\nVector Insert Profile: ${fmt(SCALE)} docs, ${DIMENSION}-dim\n`)

  const docs = generateVectorDocuments(SCALE, DIMENSION, SEED)
  const insertDocs = docs.map(({ id, ...rest }) => rest)

  console.log('--- Stage 1: Full pipeline (insertBatch) ---')
  {
    const instance = await createNarsil()
    await instance.createIndex('bench', {
      schema: { title: 'string' as const, embedding: `vector[${DIMENSION}]` as const },
      language: 'english',
      trackPositions: false,
    })

    const start = performance.now()
    await instance.insertBatch('bench', insertDocs, { skipClone: true })
    const elapsed = performance.now() - start
    console.log(`  Total: ${elapsed.toFixed(1)}ms (${fmt(Math.round(SCALE / (elapsed / 1000)))} docs/sec)`)
    await instance.shutdown()
  }

  console.log('\n--- Stage 2: Text-only baseline (no vectors) ---')
  {
    const textDocs = insertDocs.map(d => ({ title: (d as Record<string, unknown>).title }))
    const instance = await createNarsil()
    await instance.createIndex('bench', {
      schema: { title: 'string' as const },
      language: 'english',
      trackPositions: false,
    })

    const start = performance.now()
    await instance.insertBatch('bench', textDocs, { skipClone: true })
    const elapsed = performance.now() - start
    console.log(`  Total: ${elapsed.toFixed(1)}ms (${fmt(Math.round(SCALE / (elapsed / 1000)))} docs/sec)`)
    await instance.shutdown()
  }

  console.log('\n--- Stage 3: Isolate vector overhead components ---')
  {
    const rawDocs = insertDocs as Array<Record<string, unknown>>

    let cloneMs = 0
    const start1 = performance.now()
    for (const doc of rawDocs) {
      structuredClone(doc)
    }
    cloneMs = performance.now() - start1
    console.log(`  structuredClone (${fmt(SCALE)} docs): ${cloneMs.toFixed(1)}ms`)

    let extractMs = 0
    const start2 = performance.now()
    for (const doc of rawDocs) {
      const val = doc.embedding
      if (val instanceof Float32Array) continue
      if (Array.isArray(val)) {
        new Float32Array(val as number[])
      }
    }
    extractMs = performance.now() - start2
    console.log(`  Float32Array conversion (${fmt(SCALE)} docs): ${extractMs.toFixed(1)}ms`)

    let cloneWithDeleteMs = 0
    const start3 = performance.now()
    for (const doc of rawDocs) {
      const cloned = structuredClone(doc)
      delete cloned.embedding
    }
    cloneWithDeleteMs = performance.now() - start3
    console.log(`  structuredClone + delete field (${fmt(SCALE)} docs): ${cloneWithDeleteMs.toFixed(1)}ms`)

    let uuidMs = 0
    const start4 = performance.now()
    for (let i = 0; i < SCALE; i++) {
      crypto.randomUUID()
    }
    uuidMs = performance.now() - start4
    console.log(`  UUID generation (${fmt(SCALE)}): ${uuidMs.toFixed(1)}ms`)
  }

  console.log('\n--- Stage 4: Vector store insert only (bypass pipeline) ---')
  {
    const { createVectorIndex } = await import('@delali/narsil/dist/vector/vector-index.mjs') as {
      createVectorIndex: (name: string, dim: number) => {
        insert: (id: string, vec: Float32Array) => void
        size: number
      }
    }

    const vecIdx = createVectorIndex('embedding', DIMENSION)
    const vectors: Float32Array[] = []
    for (const doc of insertDocs as Array<Record<string, unknown>>) {
      const emb = doc.embedding
      if (emb instanceof Float32Array) {
        vectors.push(emb)
      } else if (Array.isArray(emb)) {
        vectors.push(new Float32Array(emb as number[]))
      }
    }

    const start = performance.now()
    for (let i = 0; i < vectors.length; i++) {
      vecIdx.insert(`doc-${i}`, vectors[i])
    }
    const elapsed = performance.now() - start
    console.log(`  Pure vector insert (store+buffer): ${elapsed.toFixed(1)}ms (${fmt(Math.round(SCALE / (elapsed / 1000)))} docs/sec)`)
    console.log(`  Index size: ${vecIdx.size}`)
  }

  console.log('\n--- Stage 5: Orama comparison ---')
  {
    const { create, insertMultiple } = await import('@orama/orama')
    const oramaDb = create({
      schema: {
        title: 'string' as const,
        embedding: `vector[${DIMENSION}]` as const,
      },
    })

    const oramaDocs = insertDocs.map((d, i) => ({
      ...(d as Record<string, unknown>),
      id: `doc-${i}`,
    }))

    const start = performance.now()
    await insertMultiple(oramaDb, oramaDocs)
    const elapsed = performance.now() - start
    console.log(`  Orama insertMultiple: ${elapsed.toFixed(1)}ms (${fmt(Math.round(SCALE / (elapsed / 1000)))} docs/sec)`)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
