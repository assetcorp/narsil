import { createNarsil, registerPartialWordSearch, registerSynonyms } from '@delali/narsil'
import { partialWordSearch } from '@delali/narsil/partial-words'
import { synonyms } from '@delali/narsil/synonyms'

registerPartialWordSearch(partialWordSearch)
registerSynonyms(synonyms)

const engine = await createNarsil({ workers: { enabled: false } })
const title = Array.from(
  { length: 128 },
  (_, at) => `river${String.fromCharCode(97 + Math.floor(at / 26), 97 + (at % 26))}`,
).join(' ')
let writing
let writeStartedDuringSearch = false
let otherIndexFinishedDuringSearch = false
try {
  await engine.createIndex('readings', {
    schema: { title: 'string', category: 'enum', embedding: 'vector[2]' },
    vectorPromotion: { threshold: 100_000, quantization: 'none' },
    partitions: { maxPartitions: 64, maxDocsPerPartition: 1_000 },
  })
  const inserted = await engine.insertBatch(
    'readings',
    Array.from({ length: 32_000 }, (_, at) => ({
      id: `reading-${String(at).padStart(5, '0')}`,
      title,
      category: 'earlier',
      embedding: [1, 0],
    })),
  )
  if (inserted.failed.length > 0) throw new Error('The documents did not load')
  await engine.rebalance('readings', 64)
  await engine.createIndex('independent', {
    schema: { title: 'string:partial' },
    synonyms: [{ words: ['separate', 'solitary'] }],
  })
  const request = {
    term: title,
    exact: true,
    limit: 10_000,
    facets: { category: {} },
    group: { fields: ['category'], maxPerGroup: 1 },
    scoring: 'dfs',
  }
  await engine.query('readings', request)
  const searching = engine.query('readings', request)
  for (let tick = 0; tick < 10_000 && writing === undefined; tick++) {
    if (engine.getStats('readings').heldSearchStates > 0) {
      writeStartedDuringSearch = true
      writing = engine.update('readings', 'reading-00000', {
        title: 'lake',
        category: 'later',
        embedding: [0, 1],
      })
      await engine.insert('independent', { title: 'separate' }, 'independent')
      otherIndexFinishedDuringSearch = engine.getStats('readings').heldSearchStates > 0
    }
    await Promise.resolve()
  }
  const answer = await searching
  await writing
  const changed = answer.hits.find(hit => hit.id === 'reading-00000')
  await engine.update('readings', 'reading-00000', { title, category: 'earlier', embedding: [1, 0] })
  writing = undefined
  let vectorWriteStartedDuringSearch = false
  const vectorSearch = engine.query('readings', { vector: { field: 'embedding', value: [1, 0] }, limit: 10_000 })
  for (let tick = 0; tick < 10_000 && writing === undefined; tick++) {
    if (engine.getStats('readings').heldSearchStates > 0) {
      vectorWriteStartedDuringSearch = true
      writing = engine.update('readings', 'reading-00000', { title: 'lake', category: 'later', embedding: [0, 1] })
    }
    await Promise.resolve()
  }
  const vectorAnswer = await vectorSearch
  await writing
  let scoreMismatches = 0
  for (const hit of vectorAnswer.hits) {
    const vector = hit.document.embedding
    const expected = vector[0] / Math.sqrt(vector[0] * vector[0] + vector[1] * vector[1])
    if (!Number.isFinite(hit.score) || Math.abs(hit.score - expected) > 1e-12) scoreMismatches++
  }
  console.log(
    JSON.stringify({
      writeStartedDuringSearch,
      otherIndexFinishedDuringSearch,
      vectorWriteStartedDuringSearch,
      vectorHits: vectorAnswer.hits.length,
      scoreMismatches,
      count: answer.count,
      earlierFacet: answer.facets?.category.values.earlier ?? 0,
      laterFacet: answer.facets?.category.values.later ?? 0,
      earlierDocument: changed?.document.title === title && changed.document.category === 'earlier',
      laterDocumentStored: (await engine.get('readings', 'reading-00000'))?.title === 'lake',
      heldAfter: engine.getStats('readings').heldSearchStates,
      partialIds: (await engine.query('independent', { term: 'para', partialWords: true })).hits.map(hit => hit.id),
      synonymIds: (await engine.query('independent', { term: 'solitary' })).hits.map(hit => hit.id),
    }),
  )
} finally {
  await writing
  await engine.shutdown()
}
if (typeof process !== 'undefined') process.exit(0)
