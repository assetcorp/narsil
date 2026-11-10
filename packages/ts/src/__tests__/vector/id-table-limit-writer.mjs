import { readFile } from 'node:fs/promises'
import { createNarsil } from '../../../dist/index.mjs'

const LOAD_POLL_MS = 50

const plan = JSON.parse(await readFile(process.env.NARSIL_ROLLBACK_PLAN, 'utf8'))
const narsil = await createNarsil({
  durability: { directory: plan.directory, mode: 'sync', checkpointIntervalMs: 0 },
  workers: { enabled: false },
})

function isLoading() {
  return narsil.vectorMaintenanceStatus(plan.index).some(status => status.loadingFromFiles)
}

if (plan.waitsForLoad) {
  while (isLoading()) await new Promise(resolve => setTimeout(resolve, LOAD_POLL_MS))
}

const loadingBefore = isLoading()
let outcome
try {
  if (plan.operation === 'update') await narsil.update(plan.index, plan.docId, plan.document)
  else await narsil.remove(plan.index, plan.docId)
  outcome = { code: 'STORED', message: '' }
} catch (error) {
  outcome = { code: error?.code ?? 'NO_CODE', message: error?.message ?? String(error) }
}
const loadingAfter = isLoading()

const stored = await narsil.get(plan.index, plan.docId)
const filtered = []
for (const query of plan.filteredQueries) {
  const found = await narsil.query(plan.index, {
    vector: { field: 'embedding', value: query, metric: 'cosine', similarity: -1 },
    filters: { fields: { group: { eq: 'rare' } } },
    limit: plan.top,
  })
  filtered.push(found.hits.map(hit => hit.id))
}
const nearest = []
for (const query of plan.selfQueries) {
  const found = await narsil.query(plan.index, {
    vector: { field: 'embedding', value: query, metric: 'cosine', efSearch: plan.efSearch },
    limit: plan.top,
  })
  nearest.push(found.hits.map(hit => hit.id))
}

process.stdout.write(
  JSON.stringify({
    loadingBefore,
    loadingAfter,
    outcome,
    stored: stored === undefined ? null : { group: stored.group, embedding: Array.from(stored.embedding) },
    filtered,
    nearest,
    count: await narsil.countDocuments(plan.index),
  }),
  () => process.exit(0),
)
