import { spawnSync } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'

const LOCK_FILE = '.narsil.lock'

describe('a write-ahead log directory held by one engine', () => {
  let root: string
  const engines: Narsil[] = []

  async function open(): Promise<Narsil> {
    const engine = await createNarsil({ durability: { directory: root, mode: 'sync' }, workers: { enabled: false } })
    engines.push(engine)
    return engine
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-directory-lock-'))
  })

  afterEach(async () => {
    for (const engine of engines.splice(0)) await engine.shutdown().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  })

  it('refuses a second engine in the same process while the first one runs', async () => {
    const first = await open()
    await first.createIndex('orders', { schema: { item: 'string' } })
    await first.insert('orders', { item: 'kettle' }, 'o1')

    await expect(open()).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
    expect(await first.countDocuments('orders')).toBe(1)
  })

  it('opens the directory again once the first engine shuts down', async () => {
    const first = await open()
    await first.createIndex('orders', { schema: { item: 'string' } })
    await first.insert('orders', { item: 'kettle' }, 'o1')
    await first.shutdown()

    const second = await open()
    expect(await second.countDocuments('orders')).toBe(1)
  })

  it('refuses a directory whose lock names another live process', async () => {
    await writeFile(join(root, LOCK_FILE), `${process.ppid}\n`)

    await expect(open()).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
  })

  it('releases the directory when recovery fails, so a repaired directory opens in the same process', async () => {
    const first = await open()
    await first.createIndex('orders', { schema: { item: 'string' } })
    await first.insert('orders', { item: 'kettle' }, 'o1')
    await first.shutdown()
    const metaPath = join(root, 'orders', 'meta')
    const intactMeta = await readFile(metaPath)
    await writeFile(metaPath, 'bytes that hold no metadata envelope')

    await expect(open()).rejects.toMatchObject({ code: 'ENVELOPE_INVALID_MAGIC' })
    await expect(access(join(root, LOCK_FILE))).rejects.toMatchObject({ code: 'ENOENT' })

    await writeFile(metaPath, intactMeta)
    const repaired = await open()
    expect(await repaired.countDocuments('orders')).toBe(1)
  })

  it('fails the next write once another engine replaces the lock file', async () => {
    const engine = await open()
    await engine.createIndex('orders', { schema: { item: 'string' } })
    await engine.insert('orders', { item: 'kettle' }, 'o1')
    await writeFile(join(root, LOCK_FILE), `${process.ppid}\n0\n0\nanother-engine\n`)

    await expect(engine.insert('orders', { item: 'toaster' }, 'o2')).rejects.toMatchObject({
      code: 'PERSISTENCE_SAVE_FAILED',
    })
  })

  it('takes over a lock left behind by a process that no longer runs', async () => {
    const finished = spawnSync(process.execPath, ['-e', ''])
    await writeFile(join(root, LOCK_FILE), `${finished.pid}\n`)

    const engine = await open()
    await engine.createIndex('orders', { schema: { item: 'string' } })
    await engine.insert('orders', { item: 'kettle' }, 'o1')
    expect(await engine.countDocuments('orders')).toBe(1)
  })
})
