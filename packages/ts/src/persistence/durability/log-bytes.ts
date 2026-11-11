import type { AppendHandle, DurableDirectory } from './durable-filesystem'

const LOG_SEGMENT_KEY = /^(.+)\/wal\/(\d+)\/\d{16}$/
const HISTORY_SEGMENT_KEY = /^(.+)\/history\/(\d+)\/\d{16}-\d{16}$/

interface LoggedFile {
  indexName: string
  partitionId: number
}

interface TrackedFile {
  partitionId: number
  bytes: number
}

interface IndexLogFiles {
  files: Map<string, TrackedFile>
  bytes: number
  bytesByPartition: Map<number, number>
}

export interface LogBytesLedger {
  readonly directory: DurableDirectory
  bytesOf(indexName: string): number | undefined
  partitionBytesOf(indexName: string, partitionId: number): number
  seed(indexName: string): Promise<void>
  forget(indexName: string): void
}

function loggedFileOf(key: string): LoggedFile | null {
  const match = LOG_SEGMENT_KEY.exec(key) ?? HISTORY_SEGMENT_KEY.exec(key)
  if (match === null) return null
  const partitionId = Number.parseInt(match[2], 10)
  return Number.isSafeInteger(partitionId) ? { indexName: match[1], partitionId } : null
}

function emptyLog(): IndexLogFiles {
  return { files: new Map(), bytes: 0, bytesByPartition: new Map() }
}

function addBytes(log: IndexLogFiles, partitionId: number, delta: number): void {
  log.bytes += delta
  log.bytesByPartition.set(partitionId, (log.bytesByPartition.get(partitionId) ?? 0) + delta)
}

function setFileBytes(log: IndexLogFiles, key: string, partitionId: number, bytes: number): void {
  const previous = log.files.get(key)
  if (previous !== undefined) addBytes(log, previous.partitionId, -previous.bytes)
  log.files.set(key, { partitionId, bytes })
  addBytes(log, partitionId, bytes)
}

function removeFile(log: IndexLogFiles, key: string): TrackedFile | undefined {
  const previous = log.files.get(key)
  if (previous === undefined) return undefined
  log.files.delete(key)
  addBytes(log, previous.partitionId, -previous.bytes)
  return previous
}

export function createLogBytesLedger(base: DurableDirectory): LogBytesLedger {
  const logs = new Map<string, IndexLogFiles>()

  function logOf(indexName: string): IndexLogFiles {
    let log = logs.get(indexName)
    if (log === undefined) {
      log = emptyLog()
      logs.set(indexName, log)
    }
    return log
  }

  function track(key: string, bytes: number): void {
    const file = loggedFileOf(key)
    if (file !== null) setFileBytes(logOf(file.indexName), key, file.partitionId, bytes)
  }

  function untrack(key: string): TrackedFile | undefined {
    const file = loggedFileOf(key)
    if (file === null) return undefined
    const log = logs.get(file.indexName)
    return log === undefined ? undefined : removeFile(log, key)
  }

  async function currentLength(key: string): Promise<number> {
    return (await base.byteLength?.(key)) ?? (await base.read(key))?.byteLength ?? 0
  }

  function trackedHandle(key: string, file: LoggedFile, handle: AppendHandle): AppendHandle {
    async function remeasure(): Promise<void> {
      const log = logs.get(file.indexName)
      if (log?.files.has(key) === true) setFileBytes(log, key, file.partitionId, await handle.size())
    }
    return {
      async append(bytes) {
        try {
          await handle.append(bytes)
        } catch (error) {
          await remeasure().catch(() => undefined)
          throw error
        }
        const log = logs.get(file.indexName)
        const entry = log?.files.get(key)
        if (log === undefined || entry === undefined) return
        entry.bytes += bytes.byteLength
        addBytes(log, file.partitionId, bytes.byteLength)
      },
      sync: () => handle.sync(),
      async truncate(byteLength) {
        try {
          await handle.truncate(byteLength)
        } finally {
          await remeasure().catch(() => undefined)
        }
      },
      size: () => handle.size(),
      close: () => handle.close(),
    }
  }

  const directory: DurableDirectory = {
    root: base.root,
    async appendHandle(key) {
      const handle = await base.appendHandle(key)
      const file = loggedFileOf(key)
      if (file === null) return handle
      if (logs.get(file.indexName)?.files.has(key) !== true) track(key, await handle.size())
      return trackedHandle(key, file, handle)
    },
    markerHandle: key => base.markerHandle(key),
    async atomicWrite(key, data) {
      await base.atomicWrite(key, data)
      if (loggedFileOf(key) === null) return
      let bytes = 0
      for (const chunk of Array.isArray(data) ? data : [data as Uint8Array]) bytes += chunk.byteLength
      track(key, bytes)
    },
    syncDirectoryOf: key => base.syncDirectoryOf(key),
    read: key => base.read(key),
    async remove(key) {
      await base.remove(key)
      untrack(key)
    },
    async move(from, to) {
      await base.move(from, to)
      const moved = untrack(from)
      if (loggedFileOf(to) !== null) track(to, moved?.bytes ?? (await currentLength(to)))
    },
    list: prefix => base.list(prefix),
    pathOf: key => base.pathOf(key),
  }
  const { readRange, byteLength, identity, lock } = base
  if (readRange !== undefined) directory.readRange = (key, offset, length) => readRange.call(base, key, offset, length)
  if (byteLength !== undefined) directory.byteLength = key => byteLength.call(base, key)
  if (identity !== undefined) directory.identity = () => identity.call(base)
  if (lock !== undefined) directory.lock = () => lock.call(base)

  return {
    directory,
    bytesOf: indexName => logs.get(indexName)?.bytes,
    partitionBytesOf: (indexName, partitionId) => logs.get(indexName)?.bytesByPartition.get(partitionId) ?? 0,
    async seed(indexName) {
      const log = emptyLog()
      for (const prefix of [`${indexName}/wal/`, `${indexName}/history/`]) {
        for (const key of await base.list(prefix)) {
          const file = loggedFileOf(key)
          if (file === null || file.indexName !== indexName) continue
          setFileBytes(log, key, file.partitionId, await currentLength(key))
        }
      }
      logs.set(indexName, log)
    },
    forget(indexName) {
      logs.delete(indexName)
    },
  }
}
