import { mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../../errors'
import { createNarsil } from '../../../narsil'
import { createFilesystemPersistence } from '../../../persistence/filesystem'

it.each([
  'wal',
  'snapshot',
] as const)('reports a typed %s metadata replacement failure and preserves the index after the obstruction is removed', async tier => {
  const directory = await mkdtemp(join(tmpdir(), 'narsil-rename-errors-'))
  const engine = await createNarsil({
    persistence: tier === 'snapshot' ? createFilesystemPersistence({ directory }) : undefined,
    durability:
      tier === 'wal' ? { directory, mode: 'sync', checkpointIntervalMs: 0 } : { tier, checkpointIntervalMs: 0 },
    workers: { enabled: false },
  })
  const meta = join(directory, 'ledgers', 'meta')
  const held = join(directory, 'ledgers', 'saved-meta')
  try {
    await engine.createIndex('ledgers', { schema: { title: 'string' } })
    await engine.insert('ledgers', { title: 'retained ledger' }, 'retained')
    await rename(meta, held)
    await mkdir(meta)
    const failure: unknown = await engine.updateBM25('ledgers', { k1: 1.5 }).catch(error => error)
    expect.soft(failure).toBeInstanceOf(NarsilError)
    expect.soft(failure).toMatchObject({ code: ErrorCodes.PERSISTENCE_SAVE_FAILED })
    expect((await readdir(join(directory, 'ledgers'))).filter(name => /[.~]tmp-/.test(name))).toEqual([])
    await rm(meta, { recursive: true })
    await rename(held, meta)
    await engine.checkpoint('ledgers')
    await engine.shutdown()
    const reopened = await createNarsil({ durability: { directory, mode: 'sync' }, workers: { enabled: false } })
    try {
      expect(await reopened.get('ledgers', 'retained')).toEqual({ title: 'retained ledger' })
    } finally {
      await reopened.shutdown()
    }
  } finally {
    await engine.shutdown()
    await rm(directory, { recursive: true, force: true })
  }
})
