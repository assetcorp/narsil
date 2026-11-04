import type { HybridObject } from 'react-native-nitro-modules'

export interface ProcessMemory {
  residentBytes: number
  availableBytes: number
}

export interface NarsilHost extends HybridObject<{ ios: 'c++'; android: 'c++' }> {
  reserveMemory(bytes: number): ArrayBuffer
  allocateMemory(bytes: number): ArrayBuffer
  ownsMemory(buffer: ArrayBuffer): boolean
  atomic(
    operation: number,
    elementKind: number,
    buffer: ArrayBuffer,
    byteIndex: number,
    value: number,
    replacement: number,
  ): number
  fillRandom(target: ArrayBuffer, byteOffset: number, byteLength: number): void
  processId(): number
  processStartedAtMs(): number
  processIsAlive(processId: number): boolean
  processMemory(): ProcessMemory
  appStorageDirectory(): string
  deflateRaw(source: ArrayBuffer, byteOffset: number, byteLength: number): ArrayBuffer
  inflateRaw(source: ArrayBuffer, byteOffset: number, byteLength: number, rawByteLength: number): ArrayBuffer
  gzip(source: ArrayBuffer, byteOffset: number, byteLength: number): ArrayBuffer
  gunzip(source: ArrayBuffer, byteOffset: number, byteLength: number, maxByteLength: number): ArrayBuffer
}
