import { loadNativeCore } from '#platform/native-core'
import { nativeSearchCoreIsEnabled, noteFallback } from '../vector/native/backend'
import type { FusionCore } from './fusion-core'

export type { FusionCore } from './fusion-core'

export function fusionCore(): FusionCore | undefined {
  if (!nativeSearchCoreIsEnabled()) return undefined
  const core = loadNativeCore()
  if (core !== null) return core
  noteFallback('fuse')
  return undefined
}
