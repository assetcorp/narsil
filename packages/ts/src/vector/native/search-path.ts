import { loadNativeCore } from '#platform/native-core'
import { nativeSearchCoreIsEnabled } from './backend'

export type VectorSearchPath = 'native' | 'wasm'

export function vectorSearchPath(): VectorSearchPath {
  return nativeSearchCoreIsEnabled() && loadNativeCore() !== null ? 'native' : 'wasm'
}
