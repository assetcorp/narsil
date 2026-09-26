import { type FsModule, getFs, getPath } from '#platform/durable-fs'
import { ErrorCodes, NarsilError } from '../../errors'
import { DIRECTORY_LOCK_ATTEMPTS } from './constants'

const LOCK_FILE_NAME = '.narsil.lock'

const lockedDirectories = new Set<string>()

function errnoOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return errnoOf(err) === 'EPERM'
  }
}

function heldElsewhere(root: string, holder: string): NarsilError {
  return new NarsilError(
    ErrorCodes.CONFIG_INVALID,
    `The durability directory "${root}" belongs to ${holder}, and the write-ahead log tier must hold its directory alone. Point this engine at another directory, or shut the other engine down first`,
    { directory: root },
  )
}

async function readHolder(fs: FsModule, lockPath: string): Promise<number | null> {
  try {
    const pid = Number.parseInt((await fs.readFile(lockPath, 'utf8')).trim(), 10)
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null
  } catch (err) {
    if (errnoOf(err) === 'ENOENT') return null
    throw err
  }
}

async function createLockFile(fs: FsModule, lockPath: string, draftPath: string): Promise<boolean> {
  await fs.writeFile(draftPath, `${process.pid}\n`, { flag: 'w' })
  try {
    await fs.link(draftPath, lockPath)
    return true
  } catch (err) {
    if (errnoOf(err) === 'EEXIST') return false
    throw err
  } finally {
    await fs.unlink(draftPath).catch(() => undefined)
  }
}

async function acquire(fs: FsModule, root: string, lockPath: string, draftPath: string): Promise<void> {
  for (let attempt = 0; attempt < DIRECTORY_LOCK_ATTEMPTS; attempt++) {
    if (await createLockFile(fs, lockPath, draftPath)) return
    const holder = await readHolder(fs, lockPath)
    if (holder !== null && holder !== process.pid && processIsRunning(holder)) {
      throw heldElsewhere(root, `process ${holder}`)
    }
    await fs.unlink(lockPath).catch(err => {
      if (errnoOf(err) !== 'ENOENT') throw err
    })
  }
  throw heldElsewhere(root, 'another process')
}

export async function lockDirectory(root: string): Promise<() => Promise<void>> {
  const fs = await getFs()
  const pathMod = await getPath()
  const resolvedRoot = pathMod.resolve(root)
  if (lockedDirectories.has(resolvedRoot)) throw heldElsewhere(root, 'another engine in this process')
  lockedDirectories.add(resolvedRoot)
  const lockPath = pathMod.join(resolvedRoot, LOCK_FILE_NAME)
  try {
    await fs.mkdir(resolvedRoot, { recursive: true })
    await acquire(fs, root, lockPath, `${lockPath}.${process.pid}`)
  } catch (err) {
    lockedDirectories.delete(resolvedRoot)
    if (err instanceof NarsilError) throw err
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_SAVE_FAILED,
      `The engine cannot take the durability directory "${root}" for itself`,
      { directory: root, cause: err instanceof Error ? err.message : String(err) },
    )
  }

  let released = false
  return async () => {
    if (released) return
    released = true
    lockedDirectories.delete(resolvedRoot)
    if ((await readHolder(fs, lockPath).catch(() => null)) === process.pid) {
      await fs.unlink(lockPath).catch(() => undefined)
    }
  }
}
