import { ErrorCodes, NarsilError } from '../../errors'

type FsModule = typeof import('node:fs/promises')
type PathModule = typeof import('node:path')
type FileHandle = import('node:fs/promises').FileHandle

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

function validateRelativeKey(key: string): void {
  if (key.length === 0) {
    throw new NarsilError(ErrorCodes.PERSISTENCE_SAVE_FAILED, 'Invalid key: empty')
  }
  if (key.includes('\0')) {
    throw new NarsilError(ErrorCodes.PERSISTENCE_SAVE_FAILED, 'Invalid key: null byte detected', { key })
  }
}

export interface AppendHandle {
  append(bytes: Uint8Array): Promise<void>
  sync(): Promise<void>
  truncate(byteLength: number): Promise<void>
  size(): Promise<number>
  close(): Promise<void>
}

export interface MarkerHandle {
  read(): Promise<Uint8Array>
  writeSlot(offset: number, slot: Uint8Array): Promise<void>
  close(): Promise<void>
}

export interface DurableDirectory {
  readonly root: string
  appendHandle(key: string): Promise<AppendHandle>
  markerHandle(key: string): Promise<MarkerHandle>
  atomicWrite(key: string, data: Uint8Array): Promise<void>
  syncDirectoryOf(key: string): Promise<void>
  read(key: string): Promise<Uint8Array | null>
  remove(key: string): Promise<void>
  list(prefix: string): Promise<string[]>
}

function wrapFsyncError(err: unknown, key: string): never {
  throw new NarsilError(
    ErrorCodes.PERSISTENCE_FSYNC_FAILED,
    `fsync failed for "${key}"; the write is not acknowledged and the node must recover from the durable log`,
    { key, cause: err instanceof Error ? err.message : String(err) },
  )
}

async function openReadWriteCreating(filePath: string, fs: FsModule): Promise<FileHandle> {
  try {
    return await fs.open(filePath, 'r+')
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err
    }
  }
  try {
    return await fs.open(filePath, 'wx+')
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err
    }
    return fs.open(filePath, 'r+')
  }
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
    wrapFsyncError(err, dirPath)
  } finally {
    if (handle !== null) {
      await handle.close().catch(() => undefined)
    }
  }
}

export function createDurableDirectory(root: string): DurableDirectory {
  if (root.trim().length === 0) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'Durable directory requires a non-empty root path')
  }

  async function resolve(key: string): Promise<{ path: string; resolvedBase: string; pathMod: PathModule }> {
    validateRelativeKey(key)
    const pathMod = await getPath()
    const resolvedBase = pathMod.resolve(root)
    const resolvedPath = pathMod.resolve(root, key)
    if (resolvedPath !== resolvedBase && !resolvedPath.startsWith(resolvedBase + pathMod.sep)) {
      throw new NarsilError(ErrorCodes.PERSISTENCE_SAVE_FAILED, 'Invalid key: path traversal detected', { key })
    }
    return { path: resolvedPath, resolvedBase, pathMod }
  }

  async function ensureDir(filePath: string, pathMod: PathModule, fs: FsModule): Promise<void> {
    await fs.mkdir(pathMod.dirname(filePath), { recursive: true })
  }

  return {
    get root() {
      return root
    },

    async appendHandle(key: string): Promise<AppendHandle> {
      const { path: filePath, pathMod } = await resolve(key)
      const fs = await getFs()
      await ensureDir(filePath, pathMod, fs)
      const handle = await fs.open(filePath, 'a')

      return {
        async append(bytes: Uint8Array): Promise<void> {
          await handle.write(bytes)
        },
        async sync(): Promise<void> {
          try {
            await handle.sync()
          } catch (err: unknown) {
            wrapFsyncError(err, key)
          }
        },
        async truncate(byteLength: number): Promise<void> {
          await handle.truncate(byteLength)
          try {
            await handle.sync()
          } catch (err: unknown) {
            wrapFsyncError(err, key)
          }
        },
        async size(): Promise<number> {
          const stat = await handle.stat()
          return stat.size
        },
        async close(): Promise<void> {
          await handle.close()
        },
      }
    },

    async markerHandle(key: string): Promise<MarkerHandle> {
      const { path: filePath, pathMod } = await resolve(key)
      const fs = await getFs()
      await ensureDir(filePath, pathMod, fs)
      const handle = await openReadWriteCreating(filePath, fs)

      return {
        async read(): Promise<Uint8Array> {
          const stat = await handle.stat()
          if (stat.size === 0) {
            return new Uint8Array(0)
          }
          const buffer = Buffer.alloc(stat.size)
          await handle.read(buffer, 0, stat.size, 0)
          return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
        },
        async writeSlot(offset: number, slot: Uint8Array): Promise<void> {
          await handle.write(slot, 0, slot.length, offset)
          try {
            await handle.sync()
          } catch (err: unknown) {
            wrapFsyncError(err, key)
          }
        },
        async close(): Promise<void> {
          await handle.close()
        },
      }
    },

    async syncDirectoryOf(key: string): Promise<void> {
      const { path: filePath, pathMod } = await resolve(key)
      const fs = await getFs()
      await fsyncDirectory(pathMod.dirname(filePath), fs)
    },

    async atomicWrite(key: string, data: Uint8Array): Promise<void> {
      const { path: filePath, pathMod } = await resolve(key)
      const fs = await getFs()
      await ensureDir(filePath, pathMod, fs)

      const dir = pathMod.dirname(filePath)
      const tempName = `${pathMod.basename(filePath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
      const tempPath = pathMod.join(dir, tempName)

      let handle: FileHandle | null = null
      try {
        handle = await fs.open(tempPath, 'w')
        await handle.write(data)
        try {
          await handle.sync()
        } catch (err: unknown) {
          wrapFsyncError(err, tempPath)
        }
        await handle.close()
        handle = null
        await fs.rename(tempPath, filePath)
        await fsyncDirectory(dir, fs)
      } catch (err: unknown) {
        if (handle !== null) {
          await handle.close().catch(() => undefined)
        }
        await fs.unlink(tempPath).catch(() => undefined)
        throw err
      }
    },

    async read(key: string): Promise<Uint8Array | null> {
      const { path: filePath } = await resolve(key)
      const fs = await getFs()
      try {
        const data = await fs.readFile(filePath)
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return null
        }
        throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, `Failed to read "${key}"`, {
          key,
          cause: err instanceof Error ? err.message : String(err),
        })
      }
    },

    async remove(key: string): Promise<void> {
      const { path: filePath, pathMod } = await resolve(key)
      const fs = await getFs()
      try {
        await fs.unlink(filePath)
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return
        }
        throw new NarsilError(ErrorCodes.PERSISTENCE_DELETE_FAILED, `Failed to delete "${key}"`, {
          key,
          cause: err instanceof Error ? err.message : String(err),
        })
      }
      await fsyncDirectory(pathMod.dirname(filePath), fs)
    },

    async list(prefix: string): Promise<string[]> {
      const fs = await getFs()
      const pathMod = await getPath()
      const resolvedBase = pathMod.resolve(root)
      const all = await listRecursive(resolvedBase, resolvedBase, pathMod, fs)
      return all.filter(entry => entry.startsWith(prefix)).sort()
    },
  }
}

async function listRecursive(dir: string, base: string, pathMod: PathModule, fs: FsModule): Promise<string[]> {
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
    const full = pathMod.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...(await listRecursive(full, base, pathMod, fs)))
    } else {
      results.push(pathMod.relative(base, full).split(pathMod.sep).join('/'))
    }
  }
  return results
}
