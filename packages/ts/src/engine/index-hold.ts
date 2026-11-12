import type { IndexStateCoordinator } from './index-state'

export interface IndexHold {
  release(): void
  outside<T>(work: () => Promise<T>): Promise<T>
  afterRelease(work: () => Promise<void>): void
  settle(): Promise<void>
}

export async function holdIndex(indexState: IndexStateCoordinator, indexName: string): Promise<IndexHold> {
  let release = await indexState.acquire(indexName)
  const afterRelease: (() => Promise<void>)[] = []
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
    afterRelease(work) {
      afterRelease.push(work)
    },
    async settle() {
      release()
      for (const work of afterRelease.splice(0)) await work()
    },
  }
}
