import { getHeapStatistics } from 'node:v8'
import { createNarsil } from '../../../../dist/index.mjs'

const INDEX = 'catalogue'
const BATCH = 2_000
const PROBE_EVERY = 97
const PROBE = 'lantern'
const HEAP_SHARE_BEFORE_THE_CHANGE = 0.62
const HITS_PAGE = 10_000

function hasProbe(position) {
  return position % PROBE_EVERY === 0
}

function titleAt(position) {
  const words = [`w${position.toString(36)}a`, `w${position.toString(36)}b`, `w${position.toString(36)}c`]
  if (hasProbe(position)) words.push(PROBE)
  return words.join(' ')
}

const heapShare = () => {
  const heap = getHeapStatistics()
  return heap.used_heap_size / heap.heap_size_limit
}

const hitIds = async (engine, term) => {
  const page = await engine.query(INDEX, { term, limit: HITS_PAGE })
  return page.hits.map(hit => hit.id).sort()
}

const engine = await createNarsil({ workers: { enabled: false } })
await engine.createIndex(INDEX, { schema: { title: 'string' }, language: 'english' })

let documents = 0
while (heapShare() < HEAP_SHARE_BEFORE_THE_CHANGE) {
  const batch = []
  for (let i = 0; i < BATCH; i++) {
    batch.push({ id: `doc-${documents}`, title: titleAt(documents) })
    documents++
  }
  await engine.insertBatch(INDEX, batch)
}

const expectedProbeHits = []
for (let position = 0; position < documents; position++) {
  if (hasProbe(position)) expectedProbeHits.push(`doc-${position}`)
}
expectedProbeHits.sort()

let code = null
try {
  await engine.changeAnalysis(INDEX, { stopWords: [PROBE] })
} catch (error) {
  code = error.code
}

const probeHitsAfterRefusal = await hitIds(engine, PROBE)
await engine.insert(INDEX, { title: PROBE }, 'late')
expectedProbeHits.push('late')
expectedProbeHits.sort()
const probeHitsAfterWrite = await hitIds(engine, PROBE)

process.stdout.write(
  `${JSON.stringify({
    code,
    documents,
    probeHitsMatch:
      JSON.stringify(probeHitsAfterRefusal) === JSON.stringify(expectedProbeHits.filter(id => id !== 'late')),
    writeMatches: JSON.stringify(probeHitsAfterWrite) === JSON.stringify(expectedProbeHits),
  })}\n`,
)
process.exit(0)
