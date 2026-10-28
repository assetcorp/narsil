import { existsSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsilClient, type NarsilClient } from '../../../client'
import type { QueryParams } from '../../../types/search'
import { startTestServer, type TestServer, waitFor } from '../../server/helpers'
import {
  INDEX,
  type Library,
  nearCentre,
  papersFrom,
  queries,
  randomShelf,
  type ShelvedPaper,
  shelvesConfig,
} from './shelved-papers'

const DOCUMENTS = 2_000
const INSERT_BATCH_SIZE = 200
const UPDATED_EACH_WAY = 100
const REMOVED = 200
const REEMBEDDED_BEFORE_RESTORE = 200
const PARTITIONS = 3
const RESTORES = 15
const K = 10
const EXHAUSTIVE_EF_SEARCH = 1_000
const COPY_TIMEOUT_MS = 60_000

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0
  let aa = 0
  let bb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    aa += a[i] * a[i]
    bb += b[i] * b[i]
  }
  return dot / Math.sqrt(aa * bb)
}

function exactTopK(library: Library, query: readonly number[]): string[] {
  return [...library.values()]
    .map(paper => ({ id: paper.id, similarity: cosine(query, paper.embedding) }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, K)
    .map(entry => entry.id)
}

function vectorSearch(query: number[]): QueryParams {
  return {
    mode: 'vector',
    limit: K,
    document: false,
    vector: { field: 'embedding', value: query, efSearch: EXHAUSTIVE_EF_SEARCH },
  }
}

function changedPapers(library: Library, from: number): ShelvedPaper[] {
  return [...library.values()].slice(from, from + 3 * UPDATED_EACH_WAY).map((paper, i) => {
    const change = Math.floor(i / UPDATED_EACH_WAY)
    if (change === 0) return { ...paper, shelf: randomShelf() }
    if (change === 1) return { ...paper, embedding: nearCentre() }
    return { ...paper, shelf: randomShelf(), embedding: nearCentre() }
  })
}

const built = existsSync(new URL('../../../../dist/workers/entry.mjs', import.meta.url))

describe.skipIf(!built)('restores over HTTP while request threads answer vector searches', () => {
  let server: TestServer
  let client: NarsilClient

  beforeEach(async () => {
    server = await startTestServer(undefined, { workers: { count: 2 } })
    client = createNarsilClient({ url: server.base })
  })

  afterEach(async () => {
    await server.stop()
  })

  async function insert(papers: ShelvedPaper[], library: Library): Promise<void> {
    const result = await client.insertBatch(INDEX, papers, { wait: true })
    expect(result.failed).toEqual([])
    for (const paper of papers) library.set(paper.id, paper)
  }

  async function update(papers: ShelvedPaper[], library: Library): Promise<void> {
    const updates = papers.map(paper => ({ docId: paper.id, document: paper }))
    const result = await client.updateBatch(INDEX, updates, { wait: true })
    expect(result.failed).toEqual([])
    for (const paper of papers) library.set(paper.id, paper)
  }

  async function threadsHoldCopies(): Promise<void> {
    await waitFor(async () => {
      await client.query(INDEX, vectorSearch(queries[0]))
      const stats = await client.getMemoryStats()
      return stats.workerCopies.some(copy => copy.indexName === INDEX && copy.scaledOut)
    }, COPY_TIMEOUT_MS)
  }

  async function disagreements(library: Library): Promise<string[]> {
    const disagreed: string[] = []
    const count = await client.countDocuments(INDEX)
    if (count !== library.size) disagreed.push(`count ${count} of ${library.size}`)
    let missed = 0
    for (const query of queries) {
      const got = new Set((await client.query(INDEX, vectorSearch(query))).hits.map(hit => hit.id))
      for (const id of exactTopK(library, query)) if (!got.has(id)) missed += 1
    }
    if (missed > 0) disagreed.push(`${missed} of ${queries.length * K} exact hits missed`)
    return disagreed
  }

  it('keeps every restored document searchable through each of many restores', async () => {
    await client.createIndex(INDEX, shelvesConfig)
    const library: Library = new Map()
    const papers = papersFrom(0, DOCUMENTS)
    for (let start = 0; start < DOCUMENTS; start += INSERT_BATCH_SIZE) {
      await insert(papers.slice(start, start + INSERT_BATCH_SIZE), library)
    }
    await update(changedPapers(library, 0), library)
    const removed = [...library.keys()].slice(3 * UPDATED_EACH_WAY, 3 * UPDATED_EACH_WAY + REMOVED)
    expect((await client.removeBatch(INDEX, removed, { wait: true })).failed).toEqual([])
    for (const id of removed) library.delete(id)
    await client.compactVectors(INDEX)
    const rebalanced = await client.rebalance(INDEX, PARTITIONS)
    expect((await client.waitForTask(rebalanced.id)).status).toBe('succeeded')
    await update(changedPapers(library, 3 * UPDATED_EACH_WAY), library)
    await threadsHoldCopies()
    const archive = new Uint8Array(await new Response(await client.snapshot(INDEX)).arrayBuffer())
    const snapshotted: Library = new Map(library)

    const failures: string[] = []
    for (let round = 0; round < RESTORES; round++) {
      const reembedded = [...snapshotted.values()]
        .slice(0, REEMBEDDED_BEFORE_RESTORE)
        .map(paper => ({ ...paper, embedding: nearCentre() }))
      await update(reembedded, library)
      const started = await client.restore(INDEX, archive)
      let restoring = true
      const finished = client.waitForTask(started.id).finally(() => {
        restoring = false
      })
      while (restoring) {
        await client.query(INDEX, vectorSearch(queries[round % queries.length])).catch(() => null)
      }
      expect((await finished).status).toBe('succeeded')
      await threadsHoldCopies()
      for (const disagreed of await disagreements(snapshotted)) failures.push(`restore ${round}: ${disagreed}`)
    }
    expect(failures).toEqual([])
  }, 600_000)
})
