import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { MAX_FILTER_TESTS } from '../../../filters/constants'
import type { QueryParams } from '../../../types/search'
import { waitFor } from '../../server/helpers'
import { COMMON_TERM, INDEX } from './corpus'
import { loadCorpus, startPatternServer, WORKER_COPIES, WORKERS_BUILT } from './harness'
import { longValueCorpus, repeatedCodePoints } from './hostile'
import { createLongQueryGate } from './long-query-gate'

const WAIT_MS = 15_000

it.skipIf(!WORKERS_BUILT)(
  'releases a long-query copy after a client disconnects during pattern matching',
  async () => {
    const gate = createLongQueryGate()
    const server = await startPatternServer(
      {
        workers: { ...WORKER_COPIES, bootstrapModule: gate.bootstrapModule },
        patternWorkCap: Number.MAX_SAFE_INTEGER,
      },
      { limits: { maxBodyBytes: 64 * 1024 * 1024 } },
    )
    const controller = new AbortController()
    try {
      await loadCorpus(server, longValueCorpus(2_000, 8_000))
      const moved = gate.moved()
      const pending = fetch(`${server.base}/indexes/${INDEX}/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          term: COMMON_TERM,
          filters: {
            or: Array.from({ length: MAX_FILTER_TESTS }, (_, at) => ({
              fields: { line: { regex: `${'a?'.repeat(500)}${String.fromCharCode(0x4e00 + at)}$` } },
            })),
          },
        }),
      }).then(
        async response => `HTTP ${response.status}: ${await response.text()}`,
        () => true,
      )
      await moved
      await delay(100)
      controller.abort()
      expect(await pending).toBe(true)
      await Promise.race([
        gate.report(),
        delay(3_000).then(() => {
          throw new Error('The cancelled matcher retained the long-query thread')
        }),
      ])
      await server.client.update(
        INDEX,
        'long00000',
        { body: 'changed entry', line: 'released', sku: 'UPDATED' },
        { wait: true },
      )
      const answer = await server.client.query(INDEX, {
        term: 'changed',
        filters: { fields: { line: { eq: 'released' } } },
      })
      expect(answer.hits.map(hit => hit.id)).toEqual(['long00000'])
      expect(answer.hits[0].document.line).toBe('released')
    } finally {
      controller.abort()
      gate.stop()
      await server.stop()
    }
  },
  60_000,
)

it.skipIf(!WORKERS_BUILT)(
  'drops a cancelled moved search and starts the next search from the destination publication',
  async () => {
    const gate = createLongQueryGate()
    const server = await startPatternServer({
      workers: { ...WORKER_COPIES, bootstrapModule: gate.bootstrapModule },
      rerankTimeout: WAIT_MS,
    })
    let release: () => void = () => undefined
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const calls: string[] = []
    const controller = new AbortController()
    const activeController = new AbortController()
    let activeSignal: AbortSignal | undefined
    let releaseActive: () => void = () => undefined
    const activeHeld = new Promise<void>(resolve => {
      releaseActive = resolve
    })
    try {
      await loadCorpus(server, longValueCorpus(240, 8_000))
      await server.client.insert(INDEX, { body: COMMON_TERM, line: 'plain', sku: 'RETAINED' }, 'retained', {
        wait: true,
      })
      server.engine.registerRerankAdapter('held', {
        async rerank(query, documents, signal) {
          calls.push(query)
          expect(documents).toEqual([query === 'first' ? COMMON_TERM : `${COMMON_TERM} changed`])
          if (query === 'first') await held
          if (query === 'active') {
            activeSignal = signal
            await activeHeld
          }
          return [1]
        },
      })
      const filters = {
        or: [
          ...Array.from({ length: MAX_FILTER_TESTS - 1 }, (_, at) => ({
            fields: { line: { eq: repeatedCodePoints(0x4e00 + at, 1_000), tolerance: 2 as const } },
          })),
          { fields: { sku: { eq: 'RETAINED' } } },
        ],
      }
      function params(query: string): QueryParams {
        return { term: COMMON_TERM, filters, limit: 1, rerank: { adapter: 'held', fields: ['body'], query } }
      }
      const first = server.client.query(INDEX, params('first'))
      void first.catch(() => undefined)
      await waitFor(async () => calls.includes('first'), WAIT_MS)
      expect((await gate.report()).movedSinceClosed).toBeGreaterThanOrEqual(1)

      const cancelled = fetch(`${server.base}/indexes/${INDEX}/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params('cancelled')),
        signal: controller.signal,
      }).then(
        () => false,
        () => true,
      )
      await waitFor(async () => (await gate.report()).movedSinceClosed >= 2, WAIT_MS)
      expect(calls).toEqual(['first'])
      controller.abort()
      expect(await cancelled).toBe(true)
      const second = server.client.query(INDEX, params('second'))
      void second.catch(() => undefined)
      await waitFor(async () => (await gate.report()).movedSinceClosed >= 3, WAIT_MS)
      expect(calls).toEqual(['first'])
      await server.client.update(
        INDEX,
        'retained',
        { body: `${COMMON_TERM} changed`, line: 'plain', sku: 'RETAINED' },
        {
          wait: true,
        },
      )
      release()
      const answer = await first
      expect(answer.hits.map(hit => hit.id)).toEqual(['retained'])
      expect(answer.hits[0].document).toEqual({ body: COMMON_TERM, line: 'plain', sku: 'RETAINED' })
      const next = await second
      expect(next.hits.map(hit => hit.id)).toEqual(['retained'])
      expect(next.hits[0].document).toEqual({ body: `${COMMON_TERM} changed`, line: 'plain', sku: 'RETAINED' })
      expect(calls).toEqual(['first', 'second'])
      const current = await server.client.query(INDEX, { term: 'changed' })
      expect(current.hits.map(hit => hit.id)).toEqual(['retained'])
      const beforeActive = (await gate.report()).movedSinceClosed
      const active = fetch(`${server.base}/indexes/${INDEX}/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params('active')),
        signal: activeController.signal,
      }).then(
        () => false,
        () => true,
      )
      await waitFor(async () => activeSignal !== undefined, WAIT_MS)
      expect((await gate.report()).movedSinceClosed).toBeGreaterThan(beforeActive)
      activeController.abort()
      expect(await active).toBe(true)
      await waitFor(async () => activeSignal?.aborted === true, 2_000)
      const afterCancellation = await server.client.query(INDEX, params('after cancellation'))
      expect(afterCancellation.hits[0].document).toEqual({
        body: `${COMMON_TERM} changed`,
        line: 'plain',
        sku: 'RETAINED',
      })
    } finally {
      controller.abort()
      activeController.abort()
      release()
      releaseActive()
      gate.stop()
      await server.stop()
    }
  },
  60_000,
)
