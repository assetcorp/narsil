import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createNarsil } from '../../../narsil'

it('reclaims interrupted metadata replacements without publishing their incomplete contents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'narsil-rename-recovery-'))
  const config = { durability: { directory }, workers: { enabled: false } }
  const engine = await createNarsil(config)
  try {
    await engine.createIndex('ledgers', { schema: { title: 'string' } })
    await engine.insert('ledgers', { title: 'committed ledger' }, 'retained')
    await engine.checkpoint('ledgers')
  } finally {
    await engine.shutdown()
  }
  const root = join(directory, 'ledgers')
  await writeFile(join(root, 'meta.tmp-123-456-partial'), new Uint8Array([0, 255]))
  await writeFile(join(root, 'manifest.tmp-123-456-partial'), new Uint8Array())
  const reopened = await createNarsil(config)
  try {
    expect(await reopened.get('ledgers', 'retained')).toEqual({ title: 'committed ledger' })
    expect((await readdir(root)).filter(name => name.includes('.tmp-'))).toEqual([])
    await reopened.checkpoint('ledgers')
    expect(await reopened.countDocuments('ledgers')).toBe(1)
  } finally {
    await reopened.shutdown()
    await rm(directory, { recursive: true, force: true })
  }
})
