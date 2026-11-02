import type { HybridObject } from 'react-native-nitro-modules'

export interface FileStatus {
  size: number
  isDirectory: boolean
  isFile: boolean
  device: string
  inode: string
  modifiedMs: number
}

export interface DirectoryEntry {
  name: string
  isDirectory: boolean
  isFile: boolean
}

export interface NarsilFiles extends HybridObject<{ ios: 'c++'; android: 'c++' }> {
  open(path: string, flags: string): number
  close(descriptor: number): void
  read(descriptor: number, target: ArrayBuffer, byteOffset: number, byteLength: number, position: number): number
  write(descriptor: number, source: ArrayBuffer, byteOffset: number, byteLength: number, position: number): number
  sync(descriptor: number): void
  readAsync(descriptor: number, byteLength: number, position: number): Promise<ArrayBuffer>
  writeAsync(
    descriptor: number,
    source: ArrayBuffer,
    byteOffset: number,
    byteLength: number,
    position: number,
  ): Promise<number>
  syncAsync(descriptor: number): Promise<void>
  truncate(descriptor: number, byteLength: number): void
  descriptorStatus(descriptor: number): FileStatus
  pathStatus(path: string): FileStatus
  makeDirectory(path: string): void
  readDirectory(path: string): DirectoryEntry[]
  rename(from: string, to: string): void
  unlink(path: string): void
  removeDirectory(path: string): void
  link(existingPath: string, newPath: string): void
}
