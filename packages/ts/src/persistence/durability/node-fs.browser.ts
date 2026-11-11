import { ErrorCodes, NarsilError } from '../storage-host/index.browser'

export type FsModule = typeof import('node:fs/promises')
export type PathModule = typeof import('node:path')

function filesystemUnavailable(): never {
  throw new NarsilError(
    ErrorCodes.CONFIG_INVALID,
    'Filesystem durability requires a Node.js runtime; use the memory or IndexedDB persistence adapters in the browser',
  )
}

export async function getFs(): Promise<FsModule> {
  return filesystemUnavailable()
}

export async function getPath(): Promise<PathModule> {
  return filesystemUnavailable()
}
