import type { ReactNativeHost } from '@delali/narsil'
import type { NarsilCore } from '../specs/core.nitro'
import type { NarsilFiles } from '../specs/files.nitro'
import type { NarsilHost } from '../specs/host.nitro'
import { adaptCore } from './core'
import { adaptFiles } from './files'
import { withNativeCode } from './native-error'

export interface NativeObjects {
  host: NarsilHost
  files: NarsilFiles
  core: NarsilCore
}

function bufferOf(view: ArrayBufferView): ArrayBuffer {
  return view.buffer as ArrayBuffer
}

function collectGarbageOn(host: NarsilHost): boolean {
  const collect: unknown = Reflect.get(host, 'collectGarbage')
  if (typeof collect !== 'function') return false
  return Reflect.apply(collect, host, []) === true
}

export function adaptHost({ host, files, core }: NativeObjects, nativeThreads: boolean): ReactNativeHost {
  return {
    reserveMemory(bytes: number): ArrayBuffer {
      try {
        return host.reserveMemory(bytes)
      } catch (error) {
        throw withNativeCode(error)
      }
    },
    allocateMemory(bytes: number): ArrayBuffer {
      try {
        return host.allocateMemory(bytes)
      } catch (error) {
        throw withNativeCode(error)
      }
    },
    ownsMemory: (buffer: ArrayBufferLike) => host.ownsMemory(buffer as ArrayBuffer),
    fillRandom(target: Uint8Array): void {
      host.fillRandom(bufferOf(target), target.byteOffset, target.byteLength)
    },
    processId: () => host.processId(),
    processStartedAtMs: () => host.processStartedAtMs(),
    processIsAlive: (processId: number) => host.processIsAlive(processId),
    processMemory: () => host.processMemory(),
    collectGarbage: () => collectGarbageOn(host),
    appStorageDirectory(): string {
      try {
        return host.appStorageDirectory()
      } catch (error) {
        throw withNativeCode(error)
      }
    },
    deflateRaw(raw: Uint8Array): Uint8Array {
      try {
        return new Uint8Array(host.deflateRaw(bufferOf(raw), raw.byteOffset, raw.byteLength))
      } catch (error) {
        throw withNativeCode(error)
      }
    },
    inflateRaw(compressed: Uint8Array, rawByteLength: number): Uint8Array {
      try {
        return new Uint8Array(
          host.inflateRaw(bufferOf(compressed), compressed.byteOffset, compressed.byteLength, rawByteLength),
        )
      } catch (error) {
        throw withNativeCode(error)
      }
    },
    gzip(data: Uint8Array): Uint8Array {
      try {
        return new Uint8Array(host.gzip(bufferOf(data), data.byteOffset, data.byteLength))
      } catch (error) {
        throw withNativeCode(error)
      }
    },
    gunzip(compressed: Uint8Array, maxByteLength: number): Uint8Array {
      try {
        return new Uint8Array(
          host.gunzip(bufferOf(compressed), compressed.byteOffset, compressed.byteLength, maxByteLength),
        )
      } catch (error) {
        throw withNativeCode(error)
      }
    },
    files: adaptFiles(files, nativeThreads),
    core: adaptCore(core, nativeThreads),
  }
}
