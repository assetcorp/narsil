export interface Semaphore {
  run<T>(task: () => Promise<T>): Promise<T>
}

export function createSemaphore(limit: number): Semaphore {
  let active = 0
  const waiting: Array<() => void> = []
  const release = (): void => {
    active -= 1
    waiting.shift()?.()
  }
  return {
    async run(task) {
      if (active >= limit) await new Promise<void>(resolve => waiting.push(resolve))
      active += 1
      try {
        return await task()
      } finally {
        release()
      }
    },
  }
}

export interface ByteBudget {
  take(bytes: number): boolean
  give(bytes: number): void
  onFreed(listener: () => void): () => void
}

export function createByteBudget(limit: number): ByteBudget {
  let used = 0
  const listeners = new Set<() => void>()
  return {
    take(bytes) {
      if (used > 0 && used + bytes > limit) return false
      used += bytes
      return true
    },
    give(bytes) {
      used = Math.max(0, used - bytes)
      for (const listener of [...listeners]) listener()
    },
    onFreed(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
