import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { threadId } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type DirectoryLock, lockDirectory } from '../../../persistence/durability/directory-lock'

const linkFailure = vi.hoisted(() => ({ code: null as string | null }))

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    link: (existingPath: string, newPath: string) =>
      linkFailure.code === null
        ? actual.link(existingPath, newPath)
        : Promise.reject(Object.assign(new Error(`link failed with ${linkFailure.code}`), { code: linkFailure.code })),
  }
})

const LOCK_FILE = '.narsil.lock'

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
  })

  afterEach(async () => {
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
})
