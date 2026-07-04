export type FsModule = typeof import('node:fs/promises')
export type PathModule = typeof import('node:path')

let cachedFs: FsModule | null = null
let cachedPath: PathModule | null = null

export async function getFs(): Promise<FsModule> {
  if (cachedFs === null) {
    cachedFs = await import('node:fs/promises')
  }
  return cachedFs
}

export async function getPath(): Promise<PathModule> {
  if (cachedPath === null) {
    cachedPath = await import('node:path')
  }
  return cachedPath
}
