import { spawn, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { threadId } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type DirectoryLock, lockDirectory } from '../../../persistence/durability/directory-lock'

const linkFailure = vi.hoisted(() => ({ code: null as string | null }))
const rivalTakeover = vi.hoisted(() => ({ lockPath: null as string | null, record: null as string | null }))
const slowUptime = vi.hoisted(() => ({ delayMs: 0 }))

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()

  async function rivalWinsFirst(path: string): Promise<void> {
    if (path !== rivalTakeover.lockPath || rivalTakeover.record === null) return
    const record = rivalTakeover.record
    rivalTakeover.record = null
    await actual.writeFile(path, record)
  }

  return {
    ...actual,
    link: (existingPath: string, newPath: string) =>
      linkFailure.code === null
        ? actual.link(existingPath, newPath)
        : Promise.reject(Object.assign(new Error(`link failed with ${linkFailure.code}`), { code: linkFailure.code })),
    unlink: async (path: string) => {
      await rivalWinsFirst(path)
      return actual.unlink(path)
    },
    rename: async (oldPath: string, newPath: string) => {
      await rivalWinsFirst(oldPath)
      return actual.rename(oldPath, newPath)
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const contents = await actual.readFile(...args)
      if (args[0] === '/proc/uptime' && slowUptime.delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, slowUptime.delayMs))
      }
      return contents
    },
  }
})

const LOCK_FILE = '.narsil.lock'

const HOLDER_RECORDING_ITS_OWN_START = `
const fs = require('node:fs')
const startMs = Math.round(Date.now() - process.uptime() * 1000)
fs.writeFileSync(process.argv[1], process.pid + '\\n0\\n' + startMs + '\\nlive-holder\\n')
process.stdout.write('HOLDING\\n')
setInterval(() => undefined, 60_000)
`

function processStartMs(): number {
  return Math.round(Date.now() - process.uptime() * 1000)
}

describe('lockDirectory', () => {
  let parent: string
  let root: string
  const locks: DirectoryLock[] = []

  async function take(path = root): Promise<DirectoryLock> {
    const lock = await lockDirectory(path)
    locks.push(lock)
    return lock
  }

  async function writeLock(content: string): Promise<void> {
    await mkdir(root, { recursive: true })
    await writeFile(join(root, LOCK_FILE), content)
  }

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), 'narsil-lock-unit-'))
    root = join(parent, 'data')
    linkFailure.code = null
    rivalTakeover.lockPath = null
    rivalTakeover.record = null
    slowUptime.delayMs = 0
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    for (const lock of locks.splice(0)) await lock.release()
    await rm(parent, { recursive: true, force: true })
  })

  it('refuses the same directory reached through a symbolic link in one process', async () => {
    await take()
    const alias = join(parent, 'alias')
    await symlink(root, alias)

    await expect(lockDirectory(alias)).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
  })

  it('refuses a lock that another thread of this process holds', async () => {
    await writeLock(`${process.pid}\n${threadId + 1}\n${processStartMs()}\nother-thread\n`)

    await expect(lockDirectory(root)).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
  })

  it('refuses a lock that another copy of the engine in this thread holds', async () => {
    await writeLock(`${process.pid}\n${threadId}\n${processStartMs()}\nother-copy\n`)

    await expect(lockDirectory(root)).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
  })

  it('takes over a lock that an earlier process with the same pid left behind', async () => {
    await writeLock(`${process.pid}\n${threadId + 1}\n${processStartMs() - 60_000}\nearlier-process\n`)

    const lock = await take()
    expect(await lock.holds()).toBe(true)
  })

  it('takes over a lock file that holds no process id', async () => {
    await writeLock('')

    const lock = await take()
    expect(await lock.holds()).toBe(true)
  })

  it('reports the lock lost once another writer replaces the lock file', async () => {
    const lock = await take()
    await writeFile(join(root, LOCK_FILE), `${process.ppid}\n0\n0\nanother-engine\n`)

    expect(await lock.holds()).toBe(false)
  })

  it('takes the lock by exclusive creation on a filesystem without hard links', async () => {
    linkFailure.code = 'ENOTSUP'
    const lock = await take()

    expect(await lock.holds()).toBe(true)
  })

  it('refuses a live holder on a filesystem without hard links', async () => {
    linkFailure.code = 'EPERM'
    await writeLock(`${process.ppid}\n`)

    await expect(lockDirectory(root)).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
  })

  it('reports any other link failure as a failed save and leaves the directory free', async () => {
    linkFailure.code = 'EIO'
    await expect(lockDirectory(root)).rejects.toMatchObject({ code: 'PERSISTENCE_SAVE_FAILED' })

    linkFailure.code = null
    await take()
  })

  it('removes the lock file on release, so the directory opens again', async () => {
    const lock = await lockDirectory(root)
    await lock.release()

    await expect(readFile(join(root, LOCK_FILE))).rejects.toMatchObject({ code: 'ENOENT' })
    await take()
  })

  it('leaves a lock file that another engine wrote in place on release', async () => {
    const lock = await lockDirectory(root)
    const replacement = `${process.ppid}\n0\n0\nanother-engine\n`
    await writeFile(join(root, LOCK_FILE), replacement)
    await lock.release()

    expect(await readFile(join(root, LOCK_FILE), 'utf8')).toBe(replacement)
  })

  it('keeps the lock of a rival that wins the directory while this engine clears a stale lock', async () => {
    const finished = spawnSync(process.execPath, ['-e', ''])
    await writeLock(`${finished.pid}\n0\n0\ncrashed-engine\n`)
    const rival = `${process.pid}\n${threadId}\n${processStartMs()}\nrival-engine\n`
    rivalTakeover.lockPath = join(root, LOCK_FILE)
    rivalTakeover.record = rival

    await expect(take()).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
    expect(await readFile(join(root, LOCK_FILE), 'utf8')).toBe(rival)
  })

  it('takes over a lock whose process exits while this engine checks it', async () => {
    const exiting = spawnSync(process.execPath, ['-e', ''])
    await writeLock(`${exiting.pid}\n0\n0\nexiting-engine\n`)
    const kill = process.kill.bind(process)
    let signalsToExitingPid = 0
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid !== exiting.pid) return kill(pid, signal)
      signalsToExitingPid += 1
      if (signalsToExitingPid === 1) return true
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    })

    const lock = await take()
    expect(await lock.holds()).toBe(true)
  })

  it.runIf(process.platform === 'linux')(
    'refuses a live holder although reading the system uptime is slow',
    async () => {
      await mkdir(root, { recursive: true })
      const holder = spawn(process.execPath, ['-e', HOLDER_RECORDING_ITS_OWN_START, join(root, LOCK_FILE)], {
        stdio: ['ignore', 'pipe', 'inherit'],
      })
      try {
        await new Promise<void>((resolve, reject) => {
          holder.stdout?.once('data', () => resolve())
          holder.once('exit', code => reject(new Error(`the holding process exited with code ${code}`)))
        })
        slowUptime.delayMs = 1_500

        await expect(take()).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
      } finally {
        holder.kill('SIGKILL')
      }
    },
    10_000,
  )
})
