export interface PendingRestores {
  finishLater(indexName: string, run: () => Promise<void>): Promise<void>
  settle(indexName: string): Promise<void>
  forget(indexName: string): void
  settleAll(): Promise<void>
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export function createPendingRestores(onFatalError: (error: Error) => void): PendingRestores {
  const pending = new Map<string, () => Promise<void>>()

  return {
    finishLater(indexName, run) {
      let running: Promise<void> | null = null
      const finish = (): Promise<void> => {
        running ??= run().then(
          () => {
            if (pending.get(indexName) === finish) pending.delete(indexName)
          },
          error => {
            running = null
            throw error
          },
        )
        return running
      }
      pending.set(indexName, finish)
      void finish().catch(error => onFatalError(toError(error)))
      return Promise.resolve()
    },

    async settle(indexName) {
      await pending.get(indexName)?.()
    },

    forget(indexName) {
      pending.delete(indexName)
    },

    async settleAll() {
      for (const finish of [...pending.values()]) await finish().catch(() => undefined)
    },
  }
}
