import type { ReactNativeDirectoryEntry, ReactNativeFileStatus, ReactNativeFiles } from '@delali/narsil'
import type { NarsilFiles } from '../specs/files.nitro'
import { withNativeCode } from './native-error'

type BlockingFiles = Omit<ReactNativeFiles, 'readAsync' | 'writeAsync' | 'syncAsync'>

function rejectedWithNativeCode(error: unknown): Promise<never> {
  return Promise.reject(withNativeCode(error))
}

function blockingFiles(files: NarsilFiles): BlockingFiles {
  return {
    open(path: string, flags: string): number {
      try {
        return files.open(path, flags)
      } catch (error) {
        throw withNativeCode(error)
      }
    },
    close(descriptor: number): void {
      try {
        files.close(descriptor)
      } catch (error) {
        throw withNativeCode(error)
      }
    },
    read(descriptor: number, target: Uint8Array, position: number): number {
      try {
        return files.read(descriptor, target.buffer as ArrayBuffer, target.byteOffset, target.byteLength, position)
      } catch (error) {
        throw withNativeCode(error)
      }
    },
    write(descriptor: number, source: Uint8Array, position: number): number {
      try {
        return files.write(descriptor, source.buffer as ArrayBuffer, source.byteOffset, source.byteLength, position)
      } catch (error) {
        throw withNativeCode(error)
      }
    },
    sync(descriptor: number): void {
      try {
        files.sync(descriptor)
      } catch (error) {
        throw withNativeCode(error)
      }
    },
    truncate(descriptor: number, byteLength: number): void {
      try {
        files.truncate(descriptor, byteLength)
      } catch (error) {
        throw withNativeCode(error)
      }
    },
    descriptorStatus(descriptor: number): ReactNativeFileStatus {
      try {
        return files.descriptorStatus(descriptor)
      } catch (error) {
        throw withNativeCode(error)
      }
    },
    pathStatus(path: string): ReactNativeFileStatus {
      try {
        return files.pathStatus(path)
      } catch (error) {
        throw withNativeCode(error)
      }
    },
    makeDirectory(path: string): void {
      try {
        files.makeDirectory(path)
      } catch (error) {
        throw withNativeCode(error)
      }
    },
    readDirectory(path: string): ReactNativeDirectoryEntry[] {
      try {
        return files.readDirectory(path)
      } catch (error) {
        throw withNativeCode(error)
      }
    },
    rename(from: string, to: string): void {
      try {
        files.rename(from, to)
      } catch (error) {
        throw withNativeCode(error)
      }
    },
    unlink(path: string): void {
      try {
        files.unlink(path)
      } catch (error) {
        throw withNativeCode(error)
      }
    },
    removeDirectory(path: string): void {
      try {
        files.removeDirectory(path)
      } catch (error) {
        throw withNativeCode(error)
      }
    },
    link(existingPath: string, newPath: string): void {
      try {
        files.link(existingPath, newPath)
      } catch (error) {
        throw withNativeCode(error)
      }
    },
  }
}

function onTheCallingThread(blocking: BlockingFiles): ReactNativeFiles {
  return {
    ...blocking,
    readAsync: async (descriptor, target, position) => blocking.read(descriptor, target, position),
    writeAsync: async (descriptor, source, position) => blocking.write(descriptor, source, position),
    syncAsync: async descriptor => blocking.sync(descriptor),
  }
}

function onNativeThreads(files: NarsilFiles, blocking: BlockingFiles): ReactNativeFiles {
  const pendingByDescriptor = new Map<number, Promise<unknown>>()

  function inOrder<T>(descriptor: number, run: () => Promise<T>): Promise<T> {
    const previous = pendingByDescriptor.get(descriptor)
    let started: Promise<T>
    if (previous !== undefined) {
      started = previous.then(run, run)
    } else {
      try {
        started = run()
      } catch (error) {
        started = Promise.reject(error)
      }
    }
    const settled = started.then(
      () => {},
      () => {},
    )
    pendingByDescriptor.set(descriptor, settled)
    settled.then(() => {
      if (pendingByDescriptor.get(descriptor) === settled) pendingByDescriptor.delete(descriptor)
    })
    return started.catch(rejectedWithNativeCode)
  }

  return {
    ...blocking,
    close(descriptor: number): void {
      const pending = pendingByDescriptor.get(descriptor)
      if (pending === undefined) {
        blocking.close(descriptor)
        return
      }
      pendingByDescriptor.delete(descriptor)
      pending.then(() => {
        try {
          files.close(descriptor)
        } catch {}
      })
    },
    readAsync(descriptor: number, target: Uint8Array, position: number): Promise<number> {
      return inOrder(descriptor, async () => {
        const bytes = await files.readAsync(descriptor, target.byteLength, position)
        target.set(new Uint8Array(bytes))
        return bytes.byteLength
      })
    },
    writeAsync(descriptor: number, source: Uint8Array, position: number): Promise<number> {
      const bytes = pendingByDescriptor.has(descriptor) ? source.slice() : source
      return inOrder(descriptor, () =>
        files.writeAsync(descriptor, bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength, position),
      )
    },
    syncAsync(descriptor: number): Promise<void> {
      return inOrder(descriptor, () => files.syncAsync(descriptor))
    },
  }
}

export function adaptFiles(files: NarsilFiles, nativeThreads: boolean): ReactNativeFiles {
  const blocking = blockingFiles(files)
  return nativeThreads ? onNativeThreads(files, blocking) : onTheCallingThread(blocking)
}
