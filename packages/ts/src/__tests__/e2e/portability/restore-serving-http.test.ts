import { readdir, rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { createNarsilClient, type NarsilClient } from '../../../client'
import {
  archiveBytes,
  configFor,
  corruptFirstSegmentBody,
  fill,
  type Gate,
  type HammerTarget,
  HELD_ROUNDS,
  hammer,
  holdRestores,
  holdsGeneration,
  LIVE,
  NEW,
  newDirectory,
  newGate,
  OLD,
  OLD_COUNT,
  SOURCE,
  sameSet,
  TERM,
} from '../../engine/snapshot/restore-fixtures'
import { scaledOut, startTestServer, type TestServer, waitFor } from '../../server/helpers'

const built = await readdir(new URL('../../../../dist/', import.meta.url)).then(
  entries => entries.includes('index.mjs'),
  () => false,
)

const CLIENT_READS_AFTER_SWAP = 8

const roots: string[] = []
const servers: TestServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop().catch(() => undefined)
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function clientTarget(client: NarsilClient): HammerTarget {
  return {
    query: async params => (await client.query(LIVE, params)).hits.map(hit => hit.id),
    get: id => client.get(LIVE, id),
    insert: async (id, document) => {
      await client.insert(LIVE, document, id)
    },
  }
}

async function serverWithBothGenerations(workers: boolean, gate: Gate) {
  const server = await startTestServer(
    undefined,
    configFor('wal', await newDirectory(roots), workers),
    async engine => {
      await fill(engine, LIVE, OLD.documents)
      await fill(engine, SOURCE, NEW.documents)
      holdRestores(engine, gate.released)
    },
  )
  servers.push(server)
  if (workers) {
    expect(server.server.requestThreadCount).toBeGreaterThan(0)
    await waitFor(() => scaledOut(server.engine, LIVE))
  }
  return { server, client: createNarsilClient({ url: server.base }) }
}

function httpCases(workers: boolean): void {
  it('answers every request from the old index or the new one while a restore task replaces it', async () => {
    const gate = newGate()
    const { server, client } = await serverWithBothGenerations(workers, gate)
    const archive = await archiveBytes(server.engine, SOURCE)

    const task = client.restore(LIVE, archive).then(started => client.waitForTask(started.id))
    const observed = await hammer(clientTarget(client), task, gate.releaseAfter)

    expect((await task).status).toBe('succeeded')
    const target = clientTarget(client)
    for (let round = 0; round < CLIENT_READS_AFTER_SWAP; round++) {
      expect(sameSet(await target.query({ term: TERM, limit: OLD_COUNT }), NEW.termHits)).toBe(true)
      expect(await target.get('old-9')).toBeUndefined()
    }
    expect(observed.failures).toEqual([])
    expect(observed.rounds).toBeGreaterThanOrEqual(HELD_ROUNDS)
    expect(await holdsGeneration(server.engine, LIVE, NEW)).toBe(true)
  }, 30_000)

  it('keeps the old index serving when the restore task fails to decode the archive', async () => {
    const gate = newGate()
    const { server, client } = await serverWithBothGenerations(workers, gate)
    const archive = corruptFirstSegmentBody(await archiveBytes(server.engine, SOURCE))

    const task = client.restore(LIVE, archive).then(started => client.waitForTask(started.id))
    const observed = await hammer(clientTarget(client), task, gate.releaseAfter)

    expect(await task).toMatchObject({ status: 'failed', error: { code: 'PERSISTENCE_CRC_MISMATCH' } })
    expect(observed.failures).toEqual([])
    expect(await holdsGeneration(server.engine, LIVE, OLD)).toBe(true)
    for (const id of observed.written) expect(await client.get(LIVE, id)).toBeDefined()
  }, 30_000)
}

describe('a restore over HTTP while clients query the index', () => {
  describe('with worker copies off', () => httpCases(false))
  describe.skipIf(!built)('with worker copies and request threads on', () => httpCases(true))
})
