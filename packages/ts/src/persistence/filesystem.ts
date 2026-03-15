import { ErrorCodes, NarsilError } from '../errors'
import type { PersistenceAdapter } from '../types/adapters'

export interface FilesystemPersistenceConfig {
  directory: string
}

type FsModule = typeof import('node:fs/promises')
type PathModule = typeof import('node:path')

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

export function createFilesystemPersistence(config: FilesystemPersistenceConfig): PersistenceAdapter {
  if (!config.directory || config.directory.trim().length === 0) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_SAVE_FAILED,
      'Filesystem persistence requires a non-empty directory path',
    )
  }

  const baseDir = config.directory

  return {
    async save(key: string, data: Uint8Array): Promise<void> {
      const resolvedPath = await resolveAndGuard(baseDir, key)
      const fs = await getFs()
      const pathMod = await getPath()
      const dir = pathMod.dirname(resolvedPath)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(resolvedPath, data)
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
