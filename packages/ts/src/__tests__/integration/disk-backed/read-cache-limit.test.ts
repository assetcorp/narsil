import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../../narsil'
import type { Narsil } from '../../../types/engine'
import type { IndexConfig } from '../../../types/schema'

const INDEX = 'pages'
const READ_CACHE_LIMIT_BYTES = 128 * 2 ** 20
const PAYLOAD_BYTES = 8_192
const DOCUMENTS = 20_000
const DOCUMENTS_PER_SEGMENT = 2_000
const SCAN_BYTES = DOCUMENTS * PAYLOAD_BYTES
const SAMPLE_EVERY_DOCUMENTS = 250
const SMALLEST_GROWTH_THAT_SHOWS_THE_CACHE_BYTES = 32 * 2 ** 20
const MUTATIONS_THAT_NEVER_TRIGGER_A_CHECKPOINT = 100_000_000
const INTERVAL_THAT_NEVER_TRIGGERS_A_CHECKPOINT_MS = 3_600_000

const CONFIG: IndexConfig = {
  schema: { title: 'string' },
  textStorage: 'disk',
  partitions: { maxPartitions: 1 },
}

type Page = { title: string; payload: string }

function idOf(at: number): string {
  return `page-${at}`
}

function pageOf(at: number): Page {
  const stamp = String(at).padStart(8, '0')
  return { title: `page ${stamp}`, payload: `${stamp}${'p'.repeat(PAYLOAD_BYTES - stamp.length)}` }
}

function storedPageOf(at: number): Page & { id: string } {
  return { id: idOf(at), ...pageOf(at) }
}

describe('the read cache of an index with its text on disk', () => {
  let root: string
  let engine: Narsil

  async function open(): Promise<void> {
    engine = await createNarsil({
      durability: {
        directory: root,
        checkpointMutationThreshold: MUTATIONS_THAT_NEVER_TRIGGER_A_CHECKPOINT,
        checkpointIntervalMs: INTERVAL_THAT_NEVER_TRIGGERS_A_CHECKPOINT_MS,
      },
      workers: { enabled: false },
    })
  }

  async function fillAndReopen(): Promise<void> {
    await engine.createIndex(INDEX, CONFIG)
    for (let start = 0; start < DOCUMENTS; start += DOCUMENTS_PER_SEGMENT) {
      const batch = []
      for (let at = start; at < start + DOCUMENTS_PER_SEGMENT; at++) batch.push({ id: idOf(at), ...pageOf(at) })
      const result = await engine.insertBatch(INDEX, batch)
      expect(result.failed).toEqual([])
      await engine.checkpoint(INDEX)
    }
    await engine.shutdown()
    await open()
  }

  function heldBytes(): number {
    return engine.getStats(INDEX).estimatedMemoryBytes
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-read-cache-'))
    await open()
  })

  afterEach(async () => {
    await engine.shutdown()
    await rm(root, { recursive: true, force: true })
  })

  it('stays within its byte limit while one scan reads every document of an index larger than the limit', async () => {
    expect(SCAN_BYTES).toBeGreaterThan(READ_CACHE_LIMIT_BYTES)
    await fillAndReopen()
    const before = heldBytes()
    let peak = before
    for (let at = 0; at < DOCUMENTS; at++) {
      expect(await engine.get(INDEX, idOf(at))).toEqual(storedPageOf(at))
      if (at % SAMPLE_EVERY_DOCUMENTS === 0) peak = Math.max(peak, heldBytes())
    }
    peak = Math.max(peak, heldBytes())
    expect(peak - before).toBeGreaterThan(SMALLEST_GROWTH_THAT_SHOWS_THE_CACHE_BYTES)
    expect(peak - before).toBeLessThanOrEqual(READ_CACHE_LIMIT_BYTES)

    for (let at = DOCUMENTS - 1; at >= 0; at--) expect(await engine.get(INDEX, idOf(at))).toEqual(storedPageOf(at))
    expect(heldBytes() - before).toBeLessThanOrEqual(READ_CACHE_LIMIT_BYTES)
  }, 300_000)
})
