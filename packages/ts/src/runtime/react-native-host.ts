import { ErrorCodes, NarsilError } from '../errors'
import type { NativeCore } from '../vector/native/types'

/**
 * The status of one file or directory in an app's private storage.
 *
 * @internal
 */
export interface ReactNativeFileStatus {
  /** The size of the file in bytes. */
  size: number
  /** Whether the path is a directory. */
  isDirectory: boolean
  /** Whether the path is a regular file. */
  isFile: boolean
  /** The device that holds the file, as a decimal string. */
  device: string
  /** The file's inode number, as a decimal string. */
  inode: string
  /** The time of the file's last change, in milliseconds since the Unix epoch. */
  modifiedMs: number
}

/**
 * One entry of a directory in an app's private storage.
 *
 * @internal
 */
export interface ReactNativeDirectoryEntry {
  /** The entry's name within its directory. */
  name: string
  /** Whether the entry is a directory. */
  isDirectory: boolean
  /** Whether the entry is a regular file. */
  isFile: boolean
}

/**
 * Synchronous file calls that the phone's native module answers. Each call
 * throws an `Error` whose `code` holds the POSIX error name, such as `ENOENT`.
 *
 * @internal
 */
export interface ReactNativeFiles {
  /**
   * Opens a file.
   *
   * @param path - The file's path.
   * @param flags - The open mode, as Node.js writes it, such as `r` or `w+`.
   * @returns The file descriptor.
   */
  open(path: string, flags: string): number
  /**
   * Closes a file descriptor.
   *
   * @param descriptor - The descriptor to close.
   */
  close(descriptor: number): void
  /**
   * Reads bytes from a file into a buffer.
   *
   * @param descriptor - The file to read.
   * @param target - Receives the bytes.
   * @param position - The offset in the file to read from.
   * @returns The number of bytes read.
   */
  read(descriptor: number, target: Uint8Array, position: number): number
  /**
   * Writes bytes from a buffer to a file.
   *
   * @param descriptor - The file to write.
   * @param source - The bytes to write.
   * @param position - The offset in the file to write at.
   * @returns The number of bytes written.
   */
  write(descriptor: number, source: Uint8Array, position: number): number
  /**
   * Flushes a file to storage, with `F_FULLFSYNC` on iOS.
   *
   * @param descriptor - The file to flush.
   */
  sync(descriptor: number): void
  /**
   * Sets the length of a file.
   *
   * @param descriptor - The file to change.
   * @param byteLength - The new length in bytes.
   */
  truncate(descriptor: number, byteLength: number): void
  /**
   * Returns the status of an open file.
   *
   * @param descriptor - The file to describe.
   */
  descriptorStatus(descriptor: number): ReactNativeFileStatus
  /**
   * Returns the status of a path.
   *
   * @param path - The path to describe.
   */
  pathStatus(path: string): ReactNativeFileStatus
  /**
   * Creates a directory.
   *
   * @param path - The directory to create.
   */
  makeDirectory(path: string): void
  /**
   * Lists the entries of a directory.
   *
   * @param path - The directory to list.
   */
  readDirectory(path: string): ReactNativeDirectoryEntry[]
  /**
   * Renames a file or directory, replacing any file at the new path.
   *
   * @param from - The current path.
   * @param to - The new path.
   */
  rename(from: string, to: string): void
  /**
   * Deletes a file.
   *
   * @param path - The file to delete.
   */
  unlink(path: string): void
  /**
   * Deletes an empty directory.
   *
   * @param path - The directory to delete.
   */
  removeDirectory(path: string): void
  /**
   * Creates a hard link to a file.
   *
   * @param existingPath - The file to link to.
   * @param newPath - The path of the new link.
   */
  link(existingPath: string, newPath: string): void
}

/**
 * What `@delali/narsil-react-native` installs on the engine's runtime, so that
 * the engine can reach memory, files, compression, and the search core that
 * Hermes lacks.
 *
 * @internal
 */
export interface ReactNativeHost {
  /**
   * Reserves address space that the system backs with memory only as each page is first written.
   *
   * @param bytes - The number of bytes to reserve.
   * @returns A buffer over the reserved space, which reads as zeros until written.
   */
  reserveMemory(bytes: number): ArrayBuffer
  /**
   * Allocates zeroed memory that the native module owns.
   *
   * @param bytes - The number of bytes to allocate.
   * @returns A buffer over the allocated memory.
   */
  allocateMemory(bytes: number): ArrayBuffer
  /**
   * Reports whether the native module allocated a buffer, which the search core requires of every region it reads.
   *
   * @param buffer - The buffer to check.
   */
  ownsMemory(buffer: ArrayBufferLike): boolean
  /**
   * Fills a buffer with random bytes from the system's secure random source.
   *
   * @param target - The buffer to fill.
   */
  fillRandom(target: Uint8Array): void
  /** Returns the app's process identifier. */
  processId(): number
  /** Returns the time at which the native module loaded, in milliseconds since the Unix epoch. */
  processStartedAtMs(): number
  /**
   * Reports whether a process with the given identifier is running.
   *
   * @param processId - The process to look for.
   */
  processIsAlive(processId: number): boolean
  /** Returns the app's resident memory and the memory that the system still allows it, both in bytes. */
  processMemory(): { residentBytes: number; availableBytes: number }
  /**
   * Runs a full garbage collection on the engine's runtime, so that the memory of dropped indexes returns to the
   * system before the engine measures it again.
   *
   * @returns Whether a collection ran.
   */
  collectGarbage(): boolean
  /** Returns the absolute path of the app's private storage directory. */
  appStorageDirectory(): string
  /**
   * Compresses bytes with raw deflate.
   *
   * @param raw - The bytes to compress.
   */
  deflateRaw(raw: Uint8Array): Uint8Array
  /**
   * Inflates raw deflate bytes of a known length.
   *
   * @param compressed - The compressed bytes.
   * @param rawByteLength - The length of the inflated bytes.
   */
  inflateRaw(compressed: Uint8Array, rawByteLength: number): Uint8Array
  /**
   * Compresses bytes into the gzip format.
   *
   * @param data - The bytes to compress.
   */
  gzip(data: Uint8Array): Uint8Array
  /**
   * Inflates gzip bytes, and throws an error whose `code` is `EFBIG` once the output passes the limit.
   *
   * @param compressed - The gzip bytes.
   * @param maxByteLength - The largest inflated length to accept.
   */
  gunzip(compressed: Uint8Array, maxByteLength: number): Uint8Array
  /** The file calls that the native module answers. */
  readonly files: ReactNativeFiles
  /** The native search core. */
  readonly core: NativeCore
}

const REACT_NATIVE_HOST_KEY = Symbol.for('@delali/narsil-react-native/host')

export const NATIVE_DEPENDENCY_MISSING_MESSAGE =
  'This app build does not include the Narsil native module, as happens in Expo Go. Install `@delali/narsil-react-native`, then make a development build with `npx expo run:ios` or `npx expo run:android`, or, in an app without Expo, run `pod install` in the `ios` folder and rebuild the app for each platform.'

export function reactNativeHost(): ReactNativeHost {
  const host = (globalThis as Record<symbol, unknown>)[REACT_NATIVE_HOST_KEY]
  if (host === null || typeof host !== 'object') {
    throw new NarsilError(ErrorCodes.NATIVE_DEPENDENCY_MISSING, NATIVE_DEPENDENCY_MISSING_MESSAGE)
  }
  return host as ReactNativeHost
}
