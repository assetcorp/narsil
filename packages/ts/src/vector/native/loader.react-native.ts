import { reactNativeHost } from '../../runtime/react-native-host'
import { NATIVE_CORE_ABI_VERSION, type NativeCore } from './types'

let loaded: NativeCore | null | undefined

export function requireSearchBackendSettings(): void {}

export function loadNativeCore(): NativeCore | null {
  if (loaded !== undefined) return loaded
  const core = reactNativeHost().core
  const reported = core.abiVersion()
  if (reported !== NATIVE_CORE_ABI_VERSION) {
    console.warn(
      `Narsil searches without its native core on this phone, because the core reports ABI version ${reported} while this build of Narsil needs ${NATIVE_CORE_ABI_VERSION}.`,
    )
    loaded = null
    return loaded
  }
  loaded = core
  return loaded
}
