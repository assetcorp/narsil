import type { ReactNativeDirectoryEntry, ReactNativeFileStatus, ReactNativeFiles } from '@delali/narsil'
import type { NarsilFiles } from '../specs/files.nitro'
import { withNativeCode } from './native-error'

export function adaptFiles(files: NarsilFiles): ReactNativeFiles {
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
