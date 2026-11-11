export interface SettlingWrites {
  track(write: Promise<void>): void
  settled(): Promise<void>
}

export function createSettlingWrites(onError: (error: unknown) => void): SettlingWrites {
  const writes = new Set<Promise<void>>()
  return {
    track(write) {
      const settled = write.catch(onError)
      writes.add(settled)
      void settled.finally(() => writes.delete(settled))
    },
    async settled() {
      await Promise.all([...writes])
    },
  }
}
