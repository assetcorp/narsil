import type { ReactNativeHost } from '@delali/narsil'
import { adaptHost, type NativeObjects } from './host'
import { installAtomics } from './stand-ins/atomics'
import { installCrypto } from './stand-ins/crypto'
import { installProcess } from './stand-ins/process'
import { installStructuredClone } from './stand-ins/structured-clone'

const REACT_NATIVE_HOST_KEY = Symbol.for('@delali/narsil-react-native/host')

export function installedHost(): ReactNativeHost {
  const host = (globalThis as Record<symbol, unknown>)[REACT_NATIVE_HOST_KEY]
  if (host === undefined) throw new Error('The Narsil engine runtime started without its native host')
  return host as ReactNativeHost
}

export function installEngineHost(natives: NativeObjects, nativeThreads: boolean): void {
  const scope = globalThis as Record<symbol, unknown>
  if (scope[REACT_NATIVE_HOST_KEY] !== undefined) return
  installStructuredClone()
  installAtomics(natives.host)
  installCrypto(natives.host)
  installProcess(natives.host)
  Object.defineProperty(globalThis, REACT_NATIVE_HOST_KEY, {
    value: adaptHost(natives, nativeThreads),
    writable: false,
    configurable: false,
    enumerable: false,
  })
}
