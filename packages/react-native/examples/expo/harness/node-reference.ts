import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { createNarsil, type Narsil } from '@delali/narsil'
import { corpus, DIMENSION, KEYWORD_TERMS, NEIGHBOURS, queryVectors } from '../src/corpus.ts'
import { checkRestoredSnapshot } from './checks.ts'
import { exactNeighbours, recallAt } from './oracle.ts'

const SCHEMA = { title: 'string', year: 'number', embedding: `vector[${DIMENSION}]` } as const
const SNAPSHOT_INDEX = 'snapshot'
const SEARCH_INDEX = 'search'
const EF_SEARCH = 200
const LIST_PAGE = 1_000

const { values } = parseArgs({ options: { mode: { type: 'string' }, fixtures: { type: 'string' } } })
const fixtures = values.fixtures ?? ''
if (fixtures.length === 0) throw new Error('Pass --fixtures')

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function filled(narsil: Narsil, indexName: string): Promise<void> {
  await narsil.createIndex(indexName, { schema: SCHEMA, language: 'english' })
  const result = await narsil.insertBatch(indexName, corpus())
  if (result.failed.length > 0) throw new Error(`${result.failed.length} documents failed to insert`)
}

async function allIds(narsil: Narsil, indexName: string): Promise<string[]> {
  const ids: string[] = []
  let cursor: string | null | undefined
  do {
    const page = await narsil.listDocuments(indexName, { cursor: cursor ?? undefined, limit: LIST_PAGE })
    for (const entry of page.documents) ids.push(entry.id)
    cursor = page.cursor
  } while (cursor !== null && cursor !== undefined)
  return ids
}

async function prepare(): Promise<void> {
  const narsil = await createNarsil({ workers: { enabled: false } })
  try {
    await filled(narsil, SNAPSHOT_INDEX)
    writeFileSync(join(fixtures, 'server.nrsl'), await collect(await narsil.snapshot(SNAPSHOT_INDEX)))
    await filled(narsil, SEARCH_INDEX)
    const documents = corpus()
    const recall: number[] = []
    for (const query of queryVectors()) {
      const answer = await narsil.query(SEARCH_INDEX, {
        mode: 'vector',
        vector: { field: 'embedding', value: query, efSearch: EF_SEARCH },
        limit: NEIGHBOURS,
      })
      recall.push(recallAt(answer.hits, exactNeighbours(documents, query, NEIGHBOURS)))
    }
    const recallAt10 = recall.reduce((sum, value) => sum + value, 0) / recall.length
    writeFileSync(join(fixtures, 'node-reference.json'), JSON.stringify({ recallAt10, recall }, null, 2))
    console.log(`Node.js recall at 10: ${recallAt10}`)
  } finally {
    await narsil.shutdown()
  }
}

async function checkPhoneSnapshot(): Promise<void> {
  const narsil = await createNarsil({ workers: { enabled: false } })
  try {
    const started = performance.now()
    await narsil.restore(SNAPSHOT_INDEX, readFileSync(join(fixtures, 'phone.nrsl')))
    const restoreMs = performance.now() - started
    const keyword = []
    for (const term of KEYWORD_TERMS) {
      const answer = await narsil.query(SNAPSHOT_INDEX, { term, limit: NEIGHBOURS })
      keyword.push({ term, hits: answer.hits.map(hit => ({ id: hit.id, score: hit.score ?? Number.NaN })) })
    }
    const vector = []
    for (const [query, value] of queryVectors().entries()) {
      const answer = await narsil.query(SNAPSHOT_INDEX, {
        mode: 'vector',
        vector: { field: 'embedding', value },
        limit: NEIGHBOURS,
      })
      vector.push({ query, hits: answer.hits.map(hit => ({ id: hit.id, score: hit.score ?? Number.NaN })) })
    }
    const checked = checkRestoredSnapshot({ ids: await allIds(narsil, SNAPSHOT_INDEX), restoreMs, keyword, vector })
    writeFileSync(join(fixtures, 'phone-snapshot-on-node.json'), JSON.stringify(checked, null, 2))
    console.log(JSON.stringify(checked, null, 2))
    if (!checked.passed) process.exitCode = 1
  } finally {
    await narsil.shutdown()
  }
}

if (values.mode === 'prepare') await prepare()
else if (values.mode === 'check-phone-snapshot') await checkPhoneSnapshot()
else throw new Error('Pass --mode prepare or --mode check-phone-snapshot')
