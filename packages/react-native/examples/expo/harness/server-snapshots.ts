import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createNarsil } from '@delali/narsil'
import { createNarsilClient, type NarsilClient } from '@delali/narsil/client'
import { createServer } from '@delali/narsil/server'
import { corpus, DIMENSION, KEYWORD_TERMS, NEIGHBOURS, queryVectors } from '../src/corpus.ts'
import { type Checked, checkRestoredSnapshot } from './checks.ts'

const SNAPSHOT_INDEX = 'snapshot'
const SERVER_SNAPSHOT = 'server.nrsl'
const SERVER_HOST = '127.0.0.1'
const LIST_PAGE = 1_000
const SCHEMA = { title: 'string', year: 'number', embedding: `vector[${DIMENSION}]` } as const

async function withServer<T>(work: (client: NarsilClient) => Promise<T>): Promise<T> {
  const engine = await createNarsil({ workers: { enabled: false } })
  const server = createServer(engine, { host: SERVER_HOST, port: 0 })
  try {
    await server.listen()
    return await work(createNarsilClient({ url: `http://${SERVER_HOST}:${server.listeningPort}` }))
  } finally {
    await server.shutdown()
  }
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function allIds(client: NarsilClient): Promise<string[]> {
  const ids: string[] = []
  let cursor: string | null | undefined
  do {
    const page = await client.listDocuments(SNAPSHOT_INDEX, { cursor: cursor ?? undefined, limit: LIST_PAGE })
    for (const entry of page.documents) ids.push(entry.id)
    cursor = page.cursor
  } while (cursor !== null && cursor !== undefined)
  return ids
}

function ranked(hits: ReadonlyArray<{ id: string; score?: number }>) {
  return hits.map(hit => ({ id: hit.id, score: hit.score ?? Number.NaN }))
}

export function writeServerSnapshot(fixtures: string): Promise<{ bytes: number; documents: number }> {
  return withServer(async client => {
    const documents = corpus()
    await client.createIndex(SNAPSHOT_INDEX, { schema: SCHEMA, language: 'english' })
    const inserted = await client.insertBatch(SNAPSHOT_INDEX, documents)
    if (inserted.failed.length > 0)
      throw new Error(`${inserted.failed.length} documents failed to insert on the server`)
    const bytes = await collect(await client.snapshot(SNAPSHOT_INDEX))
    writeFileSync(join(fixtures, SERVER_SNAPSHOT), bytes)
    return { bytes: bytes.byteLength, documents: documents.length }
  })
}

export function restorePhoneSnapshotOnServer(snapshot: Uint8Array): Promise<Checked> {
  return withServer(async client => {
    const started = performance.now()
    const task = await client.restore(SNAPSHOT_INDEX, snapshot)
    const finished = await client.waitForTask(task.id)
    const restoreMs = performance.now() - started
    if (finished.status !== 'succeeded') {
      return {
        passed: false,
        findings: [{ check: 'server restore', detail: `the restore task ended ${finished.status}` }],
        measured: { restoreMs },
      }
    }
    const keyword = []
    for (const term of KEYWORD_TERMS) {
      const answer = await client.query(SNAPSHOT_INDEX, { term, limit: NEIGHBOURS })
      keyword.push({ term, hits: ranked(answer.hits) })
    }
    const vector = []
    for (const [query, value] of queryVectors().entries()) {
      const answer = await client.query(SNAPSHOT_INDEX, {
        mode: 'vector',
        vector: { field: 'embedding', value },
        limit: NEIGHBOURS,
      })
      vector.push({ query, hits: ranked(answer.hits) })
    }
    return checkRestoredSnapshot({ ids: await allIds(client), restoreMs, keyword, vector })
  })
}
