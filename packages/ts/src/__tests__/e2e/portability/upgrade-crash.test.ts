import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const faults = vi.hoisted(() => ({ failWriteOf: null as RegExp | null, failRemoveOf: null as RegExp | null, hits: 0 }))

vi.mock('../../../persistence/durability/durable-filesystem', async importOriginal => {
  const original = await importOriginal<typeof import('../../../persistence/durability/durable-filesystem')>()
  return {
    ...original,
    createDurableDirectory: (root: string) => {
      const directory = original.createDurableDirectory(root)
      return {
        ...directory,
        root: directory.root,
        async atomicWrite(key: string, data: Uint8Array | readonly Uint8Array[]) {
          if (faults.failWriteOf?.test(key)) {
            faults.hits += 1
            throw new Error(`simulated crash writing "${key}"`)
          }
          return directory.atomicWrite(key, data)
        },
        async remove(key: string) {
          if (faults.failRemoveOf?.test(key)) {
            faults.hits += 1
            throw new Error(`simulated crash removing "${key}"`)
          }
          return directory.remove(key)
        },
      }
    },
  }
})

vi.mock('../../../persistence/durability/checkpoint-worker-dispatch', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../persistence/durability/checkpoint-worker-dispatch')>()),
  checkpointWorkerIsUsable: () => false,
  runCheckpointOnWorker: async () => null,
}))

import { createNarsil, type Narsil } from '../../../narsil'
import { decodedPayload } from './archive-oracle'
import { temporaryRoots } from './harness'
import { copyReleaseFixture, expectedFixtureDocuments, expectFixtureDocuments } from './release-0.3-fixture'

const roots = temporaryRoots()
const engines: Narsil[] = []

afterEach(async () => {
  faults.failWriteOf = null
  faults.failRemoveOf = null
  faults.hits = 0
  for (const engine of engines.splice(0)) await engine.shutdown().catch(() => undefined)
  await roots.removeAll()
})

async function manifestVersion(directory: string, indexName: string): Promise<unknown> {
  return decodedPayload(new Uint8Array(await readFile(join(directory, indexName, 'manifest')))).version
}

async function expectWholeAfterRecovery(directory: string): Promise<void> {
  faults.failWriteOf = null
  faults.failRemoveOf = null
  const engine = await createNarsil({ workers: { enabled: false }, durability: { directory } })
  engines.push(engine)
  await expectFixtureDocuments(engine, 'products', await expectedFixtureDocuments('wal-expected.json'), 'embedding')
  await expectFixtureDocuments(engine, 'notes', await expectedFixtureDocuments('wal-notes-expected.json'), null)
  expect(await manifestVersion(directory, 'products')).toBe(7)
}

describe('an upgrade of release 0.3 data that a crash interrupts', () => {
  for (const [stage, fault] of [
    ['writing its first new segment', /^products\/segments\/0\/s\d{16}$/],
    ['writing its graph', /^products\/segments\/vec-.*-graph-g\d+-p\d{16}$/],
    ['committing its manifest', /^products\/manifest$/],
  ] as const) {
    it(`leaves the earlier layout whole when it stops ${stage}, and completes on the next start`, async () => {
      const directory = await roots.make('narsil-upgrade-crash-')
      await copyReleaseFixture('wal', directory)
      faults.failWriteOf = fault

      await expect(createNarsil({ workers: { enabled: false }, durability: { directory } })).rejects.toThrow(
        /simulated crash/,
      )
      expect(faults.hits).toBeGreaterThan(0)
      expect(await manifestVersion(directory, 'products')).toBe(6)

      await expectWholeAfterRecovery(directory)
    })
  }

  it('keeps the committed upgrade when it stops removing the earlier files', async () => {
    const directory = await roots.make('narsil-upgrade-crash-cleanup-')
    await copyReleaseFixture('wal', directory)
    faults.failRemoveOf = /^products\/segments\/vec-embedding-1l4nfg2-graph-g1$/

    await createNarsil({ workers: { enabled: false }, durability: { directory } })
      .then(engine => {
        engines.push(engine)
      })
      .catch(() => undefined)

    expect(faults.hits).toBeGreaterThan(0)
    expect(await manifestVersion(directory, 'products')).toBe(7)
    for (const engine of engines.splice(0)) await engine.shutdown().catch(() => undefined)
    await expectWholeAfterRecovery(directory)
  })
})
