import { type FsModule, getFs, getPath } from '#platform/durable-fs'
import { holdDirectoryOpen, holderIsLive, removeStaleLock } from '#platform/lock-holder'
import { nodeThreadId } from '#platform/node-worker'
import { ErrorCodes, NarsilError } from '../../errors'
import { DIRECTORY_LOCK_ATTEMPTS, DIRECTORY_LOCK_SETTLE_MS } from './constants'

const LOCK_FILE_NAME = '.narsil.lock'

const HARD_LINK_UNSUPPORTED_CODES = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'])

const lockedDirectories = new Set<string>()

export interface DirectoryLock {
  holds(): Promise<boolean>
  release(): Promise<void>
}

interface LockHolder {
  pid: number
  threadId: number | null
  processStartMs: number | null
  nonce: string | null
}

type LockReading = LockHolder | 'absent' | 'unreadable'

function errnoOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code
}

function integerOrNull(text: string | undefined): number | null {
  const value = Number.parseInt(text ?? '', 10)
  return Number.isSafeInteger(value) ? value : null
}

function parseHolder(text: string): LockHolder | null {
  const [pidText, threadText, startText, nonceText] = text.split('\n')
  const pid = integerOrNull(pidText)
  if (pid === null || pid <= 0) return null
  const nonce = nonceText?.trim() ?? ''
  return {
    pid,
    threadId: integerOrNull(threadText),
    processStartMs: integerOrNull(startText),
    nonce: nonce.length > 0 ? nonce : null,
  }
}

function formatHolder(holder: LockHolder): string {
  return `${holder.pid}\n${holder.threadId ?? ''}\n${holder.processStartMs ?? ''}\n${holder.nonce ?? ''}\n`
}

async function readHolder(fs: FsModule, lockPath: string): Promise<LockReading> {
  try {
    return parseHolder(await fs.readFile(lockPath, 'utf8')) ?? 'unreadable'
  } catch (err) {
    if (errnoOf(err) === 'ENOENT') return 'absent'
    throw err
  }
}

async function settledHolder(fs: FsModule, lockPath: string): Promise<LockReading> {
  const first = await readHolder(fs, lockPath)
  if (first !== 'unreadable') return first
  await new Promise<void>(resolve => setTimeout(resolve, DIRECTORY_LOCK_SETTLE_MS))
  return readHolder(fs, lockPath)
}

function sameReading(first: LockReading, second: LockReading): boolean {
  if (typeof first !== 'object' || typeof second !== 'object') return first === second
  return formatHolder(first) === formatHolder(second)
}

function heldElsewhere(root: string, holder: string, lockPath: string): NarsilError {
  return new NarsilError(
    ErrorCodes.CONFIG_INVALID,
    `The durability directory "${root}" is in use by ${holder}, and only one engine may write a write-ahead log directory. Point this engine at another directory, or shut the other engine down first. Where no engine uses the directory, delete "${lockPath}"`,
    { directory: root },
  )
}

function holderLabel(holder: LockHolder, self: LockHolder): string {
  if (holder.pid !== self.pid) return `process ${holder.pid}`
  return holder.threadId === self.threadId ? 'another copy of Narsil in this thread' : 'another thread of this process'
}

async function createLockFileExclusively(fs: FsModule, lockPath: string, content: string): Promise<boolean> {
  try {
    await fs.writeFile(lockPath, content, { flag: 'wx' })
    return true
  } catch (err) {
    if (errnoOf(err) === 'EEXIST') return false
    throw err
  }
}

async function createLockFile(fs: FsModule, lockPath: string, draftPath: string, content: string): Promise<boolean> {
  await fs.writeFile(draftPath, content, { flag: 'w' })
  try {
    await fs.link(draftPath, lockPath)
    return true
  } catch (err) {
    const code = errnoOf(err)
    if (code === 'EEXIST') return false
    if (code !== undefined && HARD_LINK_UNSUPPORTED_CODES.has(code)) {
      return createLockFileExclusively(fs, lockPath, content)
    }
    throw err
  } finally {
    await fs.unlink(draftPath).catch(() => undefined)
  }
}

async function acquire(fs: FsModule, root: string, lockPath: string, self: LockHolder): Promise<void> {
  const draftPath = `${lockPath}.${self.pid}.${self.threadId ?? 0}`
  const content = formatHolder(self)
  for (let attempt = 0; attempt < DIRECTORY_LOCK_ATTEMPTS; attempt++) {
    if (await createLockFile(fs, lockPath, draftPath, content)) return
    const holder = await settledHolder(fs, lockPath)
    if (typeof holder === 'object' && (await holderIsLive(holder, self, lockPath))) {
      throw heldElsewhere(root, holderLabel(holder, self), lockPath)
    }
    await removeStaleLock(lockPath, `${draftPath}.aside`, text =>
      sameReading(holder, parseHolder(text) ?? 'unreadable'),
    )
  }
  throw heldElsewhere(root, 'another process', lockPath)
}

async function describeSelf(): Promise<LockHolder> {
  return {
    pid: process.pid,
    threadId: await nodeThreadId(),
    processStartMs: Math.round(Date.now() - process.uptime() * 1000),
    nonce: globalThis.crypto.randomUUID(),
  }
}

export async function lockDirectory(root: string): Promise<DirectoryLock> {
  const fs = await getFs()
  const pathMod = await getPath()
  const resolvedRoot = pathMod.resolve(root)
  const lockPath = pathMod.join(resolvedRoot, LOCK_FILE_NAME)
  const self = await describeSelf()

  async function holds(): Promise<boolean> {
    const holder = await readHolder(fs, lockPath)
    return typeof holder === 'object' && holder.nonce === self.nonce
  }

  async function removeOwnLockFile(): Promise<void> {
    if (await holds().catch(() => false)) await fs.unlink(lockPath).catch(() => undefined)
  }

  let directoryKey: string | null = null
  let closeDirectory: () => void = () => undefined
  try {
    await fs.mkdir(resolvedRoot, { recursive: true })
    const stat = await fs.stat(resolvedRoot, { bigint: true })
    const key = `${stat.dev}:${stat.ino}`
    if (lockedDirectories.has(key)) throw heldElsewhere(root, 'another engine in this process', lockPath)
    lockedDirectories.add(key)
    directoryKey = key
    await acquire(fs, root, lockPath, self)
    closeDirectory = holdDirectoryOpen(resolvedRoot)
  } catch (err) {
    if (directoryKey !== null) lockedDirectories.delete(directoryKey)
    await removeOwnLockFile()
    if (err instanceof NarsilError) throw err
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_SAVE_FAILED,
      `The engine cannot lock the durability directory "${root}"`,
      { directory: root, cause: err instanceof Error ? err.message : String(err) },
    )
  }

  const heldKey = directoryKey
  let released = false

  return {
    holds,

    async release(): Promise<void> {
      if (released) return
      released = true
      lockedDirectories.delete(heldKey)
      await removeOwnLockFile()
      closeDirectory()
    },
  }
}
