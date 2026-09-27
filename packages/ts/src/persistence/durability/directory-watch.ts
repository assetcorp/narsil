import { ErrorCodes, NarsilError } from '../../errors'
import { DIRECTORY_IDENTITY_CHECK_INTERVAL_MS } from './constants'
import type { DirectoryLock } from './directory-lock'
import type { DurableDirectory } from './durable-filesystem'

export interface DirectoryWatch {
  claim(): Promise<void>
  release(): Promise<void>
  verify(): Promise<boolean>
  verifyOnce(): Promise<void>
  start(): void
  stop(): void
}

export function unrefInterval(tick: () => void, intervalMs: number): ReturnType<typeof setInterval> {
  const timer = setInterval(tick, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  return timer
}

export function createDirectoryWatch(
  directory: DurableDirectory,
  isStopped: () => boolean,
  onLost: (error: Error) => void,
): DirectoryWatch {
  let expected: string | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let lock: DirectoryLock | null = null

  function cannotCheck(err: unknown): NarsilError {
    return new NarsilError(
      ErrorCodes.PERSISTENCE_SAVE_FAILED,
      `The engine cannot check the durability directory "${directory.root}", so it cannot confirm that a write is durable`,
      { directory: directory.root, cause: err instanceof Error ? err.message : String(err) },
    )
  }

  async function currentIdentity(): Promise<string | null | Error> {
    try {
      return (await directory.identity?.()) ?? null
    } catch (err) {
      return cannotCheck(err)
    }
  }

  async function lockTakenOver(): Promise<Error | null> {
    if (lock === null) return null
    try {
      if (await lock.holds()) return null
    } catch (err) {
      return cannotCheck(err)
    }
    return new NarsilError(
      ErrorCodes.PERSISTENCE_SAVE_FAILED,
      `The lock file of the durability directory "${directory.root}" records another engine, which may be writing the same log`,
      { directory: directory.root },
    )
  }

  async function verify(): Promise<boolean> {
    if (directory.identity === undefined || isStopped()) return true
    const current = await currentIdentity()
    if (current instanceof Error) {
      onLost(current)
      return false
    }
    if (expected === null) {
      expected = current
    } else if (current !== expected) {
      onLost(
        new NarsilError(
          ErrorCodes.PERSISTENCE_SAVE_FAILED,
          `The durability directory "${directory.root}" is missing or is a different directory from the one that this instance opens at start-up, so a write to it is not durable`,
          { directory: directory.root },
        ),
      )
      return false
    }
    const takenOver = await lockTakenOver()
    if (takenOver === null) return true
    onLost(takenOver)
    return false
  }

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  return {
    async claim(): Promise<void> {
      if (lock === null && directory.lock !== undefined) lock = await directory.lock()
    },

    async release(): Promise<void> {
      const held = lock
      lock = null
      await held?.release()
    },

    verify,

    async verifyOnce(): Promise<void> {
      if (expected === null && directory.identity !== undefined) await verify()
    },

    start(): void {
      if (directory.identity === undefined || timer !== null || isStopped()) return
      timer = unrefInterval(() => void verify(), DIRECTORY_IDENTITY_CHECK_INTERVAL_MS)
    },

    stop,
  }
}
