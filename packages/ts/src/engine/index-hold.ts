import type { IndexStateCoordinator } from './index-state'

export interface IndexHold {
  release(): void
  outside<T>(work: () => Promise<T>): Promise<T>
}

export async function holdIndex(indexState: IndexStateCoordinator, indexName: string): Promise<IndexHold> {
  let release = await indexState.acquire(indexName)
  return {
    release: () => release(),
    async outside(work) {
      release()
      try {
        return await work()
      } finally {
        release = await indexState.acquire(indexName)
      }
    },
  }
}
