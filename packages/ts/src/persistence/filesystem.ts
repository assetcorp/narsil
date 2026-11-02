import { ErrorCodes, NarsilError } from '../errors'
import type { PersistenceAdapter } from '../types/adapters'
import { OBJECT_STORE_PART_BYTES } from './constants'
import { countedChunks, requireStreamLength } from './object-store'

/**
 * Where {@link createFilesystemPersistence} writes its partitions.
 *
 * @public
 */
export interface FilesystemPersistenceConfig {
  /** The adapter writes every partition under this directory. It creates the directory, and it refuses any key that would escape it. */
  directory: string
}

type FsModule = typeof import('node:fs/promises')
type PathModule = typeof import('node:path')
type FileHandle = import('node:fs/promises').FileHandle

function unfinishedSaveName(basename: string): string {
  return `${basename}~tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

async function* readChunks(handle: FileHandle): AsyncGenerator<Uint8Array> {
  try {
    let remaining = (await handle.stat()).size
    while (remaining > 0) {
      const buffer = new Uint8Array(Math.min(remaining, OBJECT_STORE_PART_BYTES))
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null)
      if (bytesRead === 0) return
      remaining -= bytesRead
      yield bytesRead === buffer.byteLength ? buffer : buffer.subarray(0, bytesRead)
    }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

let cachedFs: FsModule | null = null
let cachedPath: PathModule | null = null

async function getFs(): Promise<FsModule> {
  if (cachedFs === null) {
    cachedFs = await import('node:fs/promises')
  }
  return cachedFs
}

async function getPath(): Promise<PathModule> {
  if (cachedPath === null) {
    cachedPath = await import('node:path')
  }
  return cachedPath
}

function validateKey(key: string): void {
  if (key.includes('\0')) {
    throw new NarsilError(ErrorCodes.PERSISTENCE_SAVE_FAILED, 'Invalid key: null byte detected')
  }
}

async function resolveAndGuard(baseDir: string, key: string): Promise<string> {
  validateKey(key)
  const pathMod = await getPath()
  const resolvedBase = pathMod.resolve(baseDir)
  const resolvedPath = pathMod.resolve(baseDir, key)

  if (resolvedPath !== resolvedBase && !resolvedPath.startsWith(resolvedBase + pathMod.sep)) {
    throw new NarsilError(ErrorCodes.PERSISTENCE_SAVE_FAILED, 'Invalid key: path traversal detected')
  }

  return resolvedPath
}

async function fsyncDirectory(dirPath: string, fs: FsModule): Promise<void> {
  let handle: FileHandle | null = null
  try {
    handle = await fs.open(dirPath, 'r')
    await handle.sync()
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EISDIR' || code === 'EPERM' || code === 'EINVAL' || code === 'ENOTSUP') {
      return
    }
    throw new NarsilError(ErrorCodes.PERSISTENCE_FSYNC_FAILED, `fsync failed for directory "${dirPath}"`, {
      cause: err instanceof Error ? err.message : String(err),
    })
  } finally {
    if (handle !== null) {
      await handle.close().catch(() => undefined)
    }
  }
}

async function listDirectoryRecursive(
  dir: string,
  baseDir: string,
  pathMod: PathModule,
  fs: FsModule,
): Promise<string[]> {
  const results: string[] = []

  let entries: Array<{ name: string; isDirectory(): boolean }>
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true })) as unknown as Array<{
      name: string
      isDirectory(): boolean
    }>
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return results
    }
    throw err
  }

  for (const entry of entries) {
    const fullPath = pathMod.join(dir, entry.name as string)
    if (entry.isDirectory()) {
      const nested = await listDirectoryRecursive(fullPath, baseDir, pathMod, fs)
      results.push(...nested)
    } else {
      const relative = pathMod.relative(baseDir, fullPath)
      results.push(relative)
    }
  }

  return results
}

/**
 * Builds a persistence adapter that writes each partition to its own file, so
 * an index comes back after a restart.
 *
 * The adapter writes each partition to a temporary file, flushes it to the
 * disk, and renames it into place, which is what keeps a crash mid-write from
 * leaving a half-written partition behind. It refuses a key that would escape
 * the configured directory.
 *
 * @param config - The directory this adapter writes partitions under.
 * @returns An adapter you pass as `persistence` when creating an engine.
 * @throws A `NarsilError` with `PERSISTENCE_SAVE_FAILED` when the directory is
 * empty or blank.
 *
 * @public
 */
export function createFilesystemPersistence(config: FilesystemPersistenceConfig): PersistenceAdapter {
  if (!config.directory || config.directory.trim().length === 0) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_SAVE_FAILED,
      'Filesystem persistence requires a non-empty directory path',
    )
  }

  const baseDir = config.directory

  return {
    directory: baseDir,
    async save(key: string, data: Uint8Array): Promise<void> {
      const resolvedPath = await resolveAndGuard(baseDir, key)
      const fs = await getFs()
      const pathMod = await getPath()
      const dir = pathMod.dirname(resolvedPath)
      await fs.mkdir(dir, { recursive: true })

      const tempPath = pathMod.join(dir, unfinishedSaveName(pathMod.basename(resolvedPath)))
      let handle: FileHandle | null = null
      try {
        handle = await fs.open(tempPath, 'w')
        await handle.write(data)
        try {
          await handle.sync()
        } catch (err: unknown) {
          throw new NarsilError(ErrorCodes.PERSISTENCE_FSYNC_FAILED, `fsync failed for "${key}"`, {
            key,
            cause: err instanceof Error ? err.message : String(err),
          })
        }
        await handle.close()
        handle = null
        await fs.rename(tempPath, resolvedPath)
        await fsyncDirectory(dir, fs)
      } catch (err: unknown) {
        if (handle !== null) {
          await handle.close().catch(() => undefined)
        }
        await fs.unlink(tempPath).catch(() => undefined)
        throw err
      }
    },

    async saveStream(key: string, data: AsyncIterable<Uint8Array>, length: number): Promise<void> {
      requireStreamLength(key, length)
      const resolvedPath = await resolveAndGuard(baseDir, key)
      const fs = await getFs()
      const pathMod = await getPath()
      const dir = pathMod.dirname(resolvedPath)
      await fs.mkdir(dir, { recursive: true })
      const tempPath = pathMod.join(dir, unfinishedSaveName(pathMod.basename(resolvedPath)))
      let handle: FileHandle | null = null
      try {
        handle = await fs.open(tempPath, 'w')
        for await (const chunk of countedChunks(key, data, length)) await handle.write(chunk)
        await handle.sync()
        await handle.close()
        handle = null
        await fs.rename(tempPath, resolvedPath)
        await fsyncDirectory(dir, fs)
      } catch (err: unknown) {
        if (handle !== null) await handle.close().catch(() => undefined)
        await fs.unlink(tempPath).catch(() => undefined)
        if (err instanceof NarsilError) throw err
        throw new NarsilError(ErrorCodes.PERSISTENCE_SAVE_FAILED, `The adapter could not save "${key}"`, {
          key,
          cause: err instanceof Error ? err.message : String(err),
        })
      }
    },

    async loadStream(key: string): Promise<AsyncIterable<Uint8Array> | null> {
      const resolvedPath = await resolveAndGuard(baseDir, key)
      const fs = await getFs()
      let handle: FileHandle
      try {
        handle = await fs.open(resolvedPath, 'r')
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw err
      }
      return readChunks(handle)
    },

    async load(key: string): Promise<Uint8Array | null> {
      const resolvedPath = await resolveAndGuard(baseDir, key)
      const fs = await getFs()
      try {
        const data = await fs.readFile(resolvedPath)
        return new Uint8Array(data)
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return null
        }
        throw err
      }
    },

    async delete(key: string): Promise<void> {
      const resolvedPath = await resolveAndGuard(baseDir, key)
      const fs = await getFs()
      try {
        await fs.unlink(resolvedPath)
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return
        }
        throw err
      }
    },

    async list(prefix: string): Promise<string[]> {
      const fs = await getFs()
      const pathMod = await getPath()
      const allFiles = await listDirectoryRecursive(baseDir, baseDir, pathMod, fs)
      return allFiles.filter(file => file.startsWith(prefix))
    },
  }
}
