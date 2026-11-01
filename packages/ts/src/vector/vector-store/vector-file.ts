import { closeSync, openSync, read as readInBackground, readSync } from 'node:fs'

export interface VectorFileReader {
  /** Reads `target.byteLength` bytes at the offset into the target, and reports false where the file is gone. */
  readInto(path: string, offset: number, target: Uint8Array): boolean
  /** Reads like {@link VectorFileReader.readInto} on a thread of the runtime's pool, so that several reads can wait on the disk at once. */
  readLater(path: string, offset: number, target: Uint8Array): Promise<boolean>
  /** Closes every descriptor whose path the given list no longer holds. */
  retainOnly(paths: ReadonlySet<string>): void
  /** Closes every descriptor. */
  close(): void
}

export function createVectorFileReader(): VectorFileReader {
  const descriptors = new Map<string, number>()
  const readsWaiting = new Map<number, number>()
  const closingAfterReads = new Set<number>()

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

  function closeNow(descriptor: number): void {
    try {
      closeSync(descriptor)
    } catch {}
  }

  function closeDescriptor(path: string, descriptor: number): void {
    descriptors.delete(path)
    if ((readsWaiting.get(descriptor) ?? 0) > 0) closingAfterReads.add(descriptor)
    else closeNow(descriptor)
  }

  function finishRead(descriptor: number): void {
    const waiting = (readsWaiting.get(descriptor) ?? 1) - 1
    if (waiting > 0) {
      readsWaiting.set(descriptor, waiting)
      return
    }
    readsWaiting.delete(descriptor)
    if (closingAfterReads.delete(descriptor)) closeNow(descriptor)
  }

  function readRest(
    descriptor: number,
    offset: number,
    target: Uint8Array,
    done: number,
    finish: (whole: boolean) => void,
  ): void {
    readInBackground(descriptor, target, done, target.byteLength - done, offset + done, (error, chunk) => {
      if (error !== null || chunk <= 0) finish(false)
      else if (done + chunk === target.byteLength) finish(true)
      else readRest(descriptor, offset, target, done + chunk, finish)
    })
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

    readLater(path, offset, target) {
      const descriptor = descriptorOf(path)
      if (descriptor === null) return Promise.resolve(false)
      if (target.byteLength === 0) return Promise.resolve(true)
      readsWaiting.set(descriptor, (readsWaiting.get(descriptor) ?? 0) + 1)
      return new Promise(resolve => {
        readRest(descriptor, offset, target, 0, whole => {
          finishRead(descriptor)
          resolve(whole)
        })
      })
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
