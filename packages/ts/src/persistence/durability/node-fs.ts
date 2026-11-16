import {
  HELD_FILE_RETRY_FIRST_PAUSE_MS,
  HELD_FILE_RETRY_LONGEST_PAUSE_MS,
  HELD_FILE_RETRY_WINDOW_MS,
} from './constants'

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

function heldByAnotherHandle(error: unknown, retriesMissing: boolean): boolean {
  if (typeof process === 'undefined' || process.platform !== 'win32') return false
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EPERM' || code === 'EBUSY' || (retriesMissing && code === 'ENOENT')
}

function pause(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function retriedWhileHeld(operation: () => Promise<void>, retriesMissing: boolean): Promise<void> {
  let deadline: number | null = null
  let wait = HELD_FILE_RETRY_FIRST_PAUSE_MS
  for (;;) {
    try {
      await operation()
      return
    } catch (error) {
      if (!heldByAnotherHandle(error, retriesMissing)) throw error
      const now = performance.now()
      deadline ??= now + HELD_FILE_RETRY_WINDOW_MS
      if (now + wait >= deadline) throw error
    }
    await pause(wait)
    wait = Math.min(2 * wait, HELD_FILE_RETRY_LONGEST_PAUSE_MS)
  }
}

export async function renameReplacing(from: string, to: string): Promise<void> {
  const fs = await getFs()
  await retriedWhileHeld(() => fs.rename(from, to), true)
}

export async function renameUnlessMissing(from: string, to: string): Promise<void> {
  const fs = await getFs()
  await retriedWhileHeld(() => fs.rename(from, to), false)
}
