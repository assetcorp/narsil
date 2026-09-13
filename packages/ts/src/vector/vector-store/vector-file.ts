import { closeSync, openSync, readSync } from 'node:fs'

/**
 * Reads full-precision vectors by position out of the vector files a
 * checkpoint wrote, keeping one file descriptor open per file so that a
 * re-score makes one system call.
 *
 * @internal
 */
export interface VectorFileReader {
  /** Reads `target.byteLength` bytes at the offset into the target, and reports false where the file is gone. */
  readInto(path: string, offset: number, target: Uint8Array): boolean
  /** Closes every descriptor whose path the given list no longer holds. */
  retainOnly(paths: ReadonlySet<string>): void
  /** Closes every descriptor. */
  close(): void
}

/**
 * Builds a reader over the current thread's descriptors.
 *
 * @returns The reader.
 *
 * @internal
 */
export function createVectorFileReader(): VectorFileReader {
  const descriptors = new Map<string, number>()

  function descriptorOf(path: string): number | null {
    const open = descriptors.get(path)
    if (open !== undefined) return open
    try {
      const descriptor = openSync(path, 'r')
      descriptors.set(path, descriptor)
      return descriptor
    } catch {
      return null
    }
  }

  function closeDescriptor(path: string, descriptor: number): void {
    descriptors.delete(path)
    try {
      closeSync(descriptor)
    } catch {}
  }

  return {
    readInto(path, offset, target) {
      const descriptor = descriptorOf(path)
      if (descriptor === null) return false
      let read = 0
      while (read < target.byteLength) {
        let chunk: number
        try {
          chunk = readSync(descriptor, target, read, target.byteLength - read, offset + read)
        } catch {
          closeDescriptor(path, descriptor)
          return false
        }
        if (chunk <= 0) return false
        read += chunk
      }
      return true
    },

    retainOnly(paths) {
      for (const [path, descriptor] of descriptors) {
        if (!paths.has(path)) closeDescriptor(path, descriptor)
      }
    },

    close() {
      for (const [path, descriptor] of descriptors) closeDescriptor(path, descriptor)
    },
  }
}
