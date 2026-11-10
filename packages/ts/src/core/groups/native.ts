import { loadNativeCore } from '#platform/native-core'
import { nativeSearchCoreIsEnabled, noteFallback } from '../../vector/native/backend'
import { groupHits as portableGroupHits } from './portable'

export const groupHits: typeof portableGroupHits = (...args) => {
  if (!nativeSearchCoreIsEnabled()) return portableGroupHits(...args)
  const core = loadNativeCore()
  if (core !== null) return core.groupHits(...args)
  noteFallback('groupHits')
  return portableGroupHits(...args)
}
