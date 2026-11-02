import { getFs } from '#platform/durable-fs'
import { reactNativeHost } from '../../runtime/react-native-host'
import { DIRECTORY_LOCK_PROCESS_START_TOLERANCE_MS } from './constants'

interface RecordedProcess {
  pid: number
  processStartMs: number | null
}

function errnoOf(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code
}

export async function holderIsLive(
  holder: RecordedProcess,
  self: RecordedProcess,
  _lockPath: string,
): Promise<boolean> {
  if (holder.pid === self.pid) {
    if (holder.processStartMs === null || self.processStartMs === null) return false
    return Math.abs(holder.processStartMs - self.processStartMs) <= DIRECTORY_LOCK_PROCESS_START_TOLERANCE_MS
  }
  return reactNativeHost().processIsAlive(holder.pid)
}

export function holdDirectoryOpen(_directory: string): () => void {
  return () => undefined
}

export async function removeStaleLock(
  lockPath: string,
  asidePath: string,
  isStale: (text: string) => boolean,
): Promise<void> {
  const fs = await getFs()
  try {
    await fs.rename(lockPath, asidePath)
  } catch (err) {
    if (errnoOf(err) === 'ENOENT') return
    throw err
  }
  try {
    const moved = await fs.readFile(asidePath, 'utf8')
    if (!isStale(moved)) {
      await fs.writeFile(lockPath, moved, { flag: 'wx' }).catch((err: unknown) => {
        if (errnoOf(err) !== 'EEXIST') throw err
      })
    }
  } finally {
    await fs.unlink(asidePath).catch(() => undefined)
  }
}
