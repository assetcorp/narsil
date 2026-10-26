import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'

const LOCK_FILE = '.narsil.lock'

const CHILD_WRITER = fileURLToPath(new URL('./durability-crash/child-writer-dist.mjs', import.meta.url))

describe('a write-ahead log directory held by one engine', () => {
  let root: string
  const engines: Narsil[] = []
  const children: ChildProcess[] = []

  async function open(): Promise<Narsil> {
    const engine = await createNarsil({ durability: { directory: root, mode: 'sync' }, workers: { enabled: false } })
    engines.push(engine)
    return engine
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-directory-lock-'))
  })

  afterEach(async () => {
    for (const child of children.splice(0)) child.kill('SIGKILL')
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

  it('refuses a directory that an engine in another live process holds, and takes it over once that process is killed', async () => {
    const holder = spawn(process.execPath, [CHILD_WRITER], {
      env: { ...process.env, NARSIL_WAL_DIR: root, NARSIL_DOC_COUNT: '3', NARSIL_EXIT: 'wait-for-kill' },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    children.push(holder)
    const exited = new Promise(resolve => holder.once('exit', resolve))
    await new Promise<void>((resolve, reject) => {
      holder.stdout?.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('ACKED')) resolve()
      })
      holder.once('exit', code => reject(new Error(`the holding engine exited with code ${code}`)))
    })

    await expect(open()).rejects.toMatchObject({ code: 'CONFIG_INVALID' })

    holder.kill('SIGKILL')
    await exited
    const engine = await open()
    expect(await engine.countDocuments('movies')).toBe(3)
  })

  describe.runIf(process.platform === 'linux')('a lock whose process id is in use again by something else', () => {
    async function openOverLockOf(pid: number): Promise<void> {
      await writeFile(join(root, LOCK_FILE), `${pid}\n0\n0\ncrashed-engine\n`)

      const engine = await open()
      await engine.createIndex('orders', { schema: { item: 'string' } })
      await engine.insert('orders', { item: 'kettle' }, 'o1')
      expect(await engine.countDocuments('orders')).toBe(1)
    }

    it('takes over the lock when that id now belongs to a thread of the opening process', async () => {
      const threadIds = (await readdir('/proc/self/task')).map(Number).filter(id => id !== process.pid)
      expect(threadIds.length).toBeGreaterThan(0)

      await openOverLockOf(threadIds[0] ?? process.pid)
    })

    it('takes over the lock when that id now belongs to a live process that started after the recorded one', async () => {
      await openOverLockOf(process.ppid)
    })
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
