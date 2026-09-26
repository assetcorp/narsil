import { ErrorCodes, NarsilError } from '../../errors'
import { DIRECTORY_IDENTITY_CHECK_INTERVAL_MS } from './constants'
import type { DurableDirectory } from './durable-filesystem'

export interface DirectoryWatch {
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

  async function currentIdentity(): Promise<string | null | Error> {
    try {
      return (await directory.identity?.()) ?? null
    } catch (err) {
      return new NarsilError(
        ErrorCodes.PERSISTENCE_SAVE_FAILED,
        `The engine cannot check the durability directory "${directory.root}", so it cannot confirm that a write reaches a durable file`,
        { directory: directory.root, cause: err instanceof Error ? err.message : String(err) },
      )
    }
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
      return true
    }
    if (current === expected) return true
    onLost(
      new NarsilError(
        ErrorCodes.PERSISTENCE_SAVE_FAILED,
        `The durability directory "${directory.root}" is missing or is a different directory from the one that this instance opened, so a write to it reaches no durable file`,
        { directory: directory.root },
      ),
    )
    return false
  }

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  return {
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
