import { readdir, rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import type { Narsil } from '../../../narsil'
import { scaledOut, waitFor } from '../../server/helpers'
import {
  archiveBytes,
  configFor,
  corruptFirstSegmentBody,
  type EngineKind,
  engineTarget,
  fill,
  HELD_ROUNDS,
  hammer,
  heldBack,
  holdsGeneration,
  LIVE,
  NEW,
  NEW_COUNT,
  newDirectory,
  newGate,
  OLD,
  openEngine,
  SOURCE,
} from './restore-fixtures'

const built = await readdir(new URL('../../../../dist/', import.meta.url)).then(
  entries => entries.includes('index.mjs'),
  () => false,
)

const roots: string[] = []
const engines: Narsil[] = []

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.shutdown().catch(() => undefined)
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function engineWithBothGenerations(kind: EngineKind, workers: boolean): Promise<Narsil> {
  const engine = await openEngine(configFor(kind, await newDirectory(roots), workers), engines)
  await fill(engine, LIVE, OLD.documents)
  await fill(engine, SOURCE, NEW.documents)
  if (workers) await waitFor(() => scaledOut(engine, LIVE))
  return engine
}

const ARCHIVE_DAMAGE = [
  {
    damage: 'is cut short, so that it fails its manifest check',
    damaged: (archive: Uint8Array) => archive.slice(0, archive.byteLength - 4_096),
    code: 'PERSISTENCE_LOAD_FAILED',
  },
  {
    damage: 'passes its manifest check and then fails to decode',
    damaged: corruptFirstSegmentBody,
    code: 'PERSISTENCE_CRC_MISMATCH',
  },
]

function servingCases(workers: boolean): void {
  for (const kind of ['memory', 'wal', 'snapshot'] as const) {
    it(`answers every request from the old index or the new one, whole, on an engine in ${kind}`, async () => {
      const engine = await engineWithBothGenerations(kind, workers)
      const archive = await engine.snapshot(SOURCE)
      const gate = newGate()

      const restored = engine.restore(LIVE, heldBack(archive, gate.released))
      const observed = await hammer(engineTarget(engine, LIVE), restored, gate.releaseAfter)
      await restored

      expect(observed.failures).toEqual([])
      expect(observed.rounds).toBeGreaterThanOrEqual(HELD_ROUNDS)
      expect(await engine.countDocuments(LIVE)).toBeGreaterThanOrEqual(NEW_COUNT)
      expect(await holdsGeneration(engine, LIVE, NEW)).toBe(true)
    }, 30_000)

    if (kind !== 'wal') continue
    for (const { damage, damaged, code } of ARCHIVE_DAMAGE) {
      it(`keeps the old index serving when the archive ${damage}, on an engine in ${kind}`, async () => {
        const engine = await engineWithBothGenerations(kind, workers)
        const archive = damaged(await archiveBytes(engine, SOURCE))

        const restored = engine.restore(LIVE, archive)
        const observed = await hammer(engineTarget(engine, LIVE), restored)
        await expect(restored).rejects.toMatchObject({ code })

        expect(observed.failures).toEqual([])
        expect(await holdsGeneration(engine, LIVE, OLD)).toBe(true)
        for (const id of observed.written) expect(await engine.get(LIVE, id)).toBeDefined()
      }, 30_000)
    }
  }
}

describe('a restore over an index that serves requests', () => {
  describe('with worker copies off', () => servingCases(false))
  describe.skipIf(!built)('with worker copies on', () => servingCases(true))
})

describe('a restore that survives a restart', () => {
  for (const kind of ['wal', 'snapshot'] as const) {
    it(`reopens the restored index whole, on an engine in ${kind}`, async () => {
      const directory = await newDirectory(roots)
      const engine = await openEngine(configFor(kind, directory, false), engines)
      await fill(engine, LIVE, OLD.documents)
      await fill(engine, SOURCE, NEW.documents)
      await engine.restore(LIVE, await engine.snapshot(SOURCE))
      await engine.insert(LIVE, { body: 'the beacon', group: 'odd', embedding: [1, 0, 0, 0, 0, 0, 0, 0] }, 'after')
      await engine.checkpoint(LIVE)
      await engine.shutdown()

      const reopened = await openEngine(configFor(kind, directory, false), engines)
      expect(await holdsGeneration(reopened, LIVE, NEW)).toBe(true)
      expect(await reopened.get(LIVE, 'after')).toMatchObject({ body: 'the beacon' })
      expect(await reopened.countDocuments(LIVE)).toBe(NEW_COUNT + 1)
      const files = await readdir(directory, { recursive: true, withFileTypes: true })
      const leftovers = files
        .filter(file => file.isFile() && file.name !== '.narsil.lock')
        .map(file => `${file.parentPath}/${file.name}`.slice(directory.length + 1))
        .filter(path => path.startsWith('.'))
      expect(leftovers).toEqual([])
    }, 30_000)
  }

  it('restores into an index whose name is 255 characters long', async () => {
    const directory = await newDirectory(roots)
    const longName = `n${'x'.repeat(254)}`
    const engine = await openEngine(configFor('wal', directory, false), engines)
    await fill(engine, longName, OLD.documents)
    await fill(engine, SOURCE, NEW.documents)
    await engine.restore(longName, await engine.snapshot(SOURCE))
    expect(await holdsGeneration(engine, longName, NEW)).toBe(true)
    await engine.shutdown()

    const reopened = await openEngine(configFor('wal', directory, false), engines)
    expect(await holdsGeneration(reopened, longName, NEW)).toBe(true)
  }, 30_000)
})
