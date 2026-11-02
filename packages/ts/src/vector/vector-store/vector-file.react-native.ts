import { reactNativeHost } from '../../runtime/react-native-host'
import type { VectorFileReader } from './vector-file'

export type { VectorFileReader } from './vector-file'

export function createVectorFileReader(): VectorFileReader {
  const descriptors = new Map<string, number>()

  function descriptorOf(path: string): number | null {
    const open = descriptors.get(path)
    if (open !== undefined) return open
    try {
      const descriptor = reactNativeHost().files.open(path, 'r')
      descriptors.set(path, descriptor)
      return descriptor
    } catch {
      return null
    }
  }

  function closeDescriptor(path: string, descriptor: number): void {
    descriptors.delete(path)
    try {
      reactNativeHost().files.close(descriptor)
    } catch {}
  }

  function readInto(path: string, offset: number, target: Uint8Array): boolean {
    const descriptor = descriptorOf(path)
    if (descriptor === null) return false
    const files = reactNativeHost().files
    let read = 0
    while (read < target.byteLength) {
      let chunk: number
      try {
        chunk = files.read(descriptor, target.subarray(read), offset + read)
      } catch {
        closeDescriptor(path, descriptor)
        return false
      }
      if (chunk <= 0) return false
      read += chunk
    }
    return true
  }

  return {
    readInto,

    readLater(path, offset, target) {
      return Promise.resolve(readInto(path, offset, target))
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
