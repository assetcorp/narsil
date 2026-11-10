import { loadNativeCore } from '#platform/native-core'
import { nativeSearchCoreIsEnabled, noteFallback } from '../vector/native/backend'
import { placePinned as portablePlacePinned } from './pinned-core'

export const placePinned: typeof portablePlacePinned = (...args) => {
  if (!nativeSearchCoreIsEnabled()) return portablePlacePinned(...args)
  const core = loadNativeCore()
  if (core !== null) return core.placePinned(...args)
  noteFallback('placePinned')
  return portablePlacePinned(...args)
}
