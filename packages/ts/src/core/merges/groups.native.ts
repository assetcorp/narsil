import { loadNativeCore } from '#platform/native-core'
import { nativeSearchCoreIsEnabled, noteFallback } from '../../vector/native/backend'
import { mergeGroups as portableMergeGroups } from './groups'

export const mergeGroups: typeof portableMergeGroups = (...args) => {
  if (!nativeSearchCoreIsEnabled()) return portableMergeGroups(...args)
  const core = loadNativeCore()
  if (core !== null) return core.mergeGroups(...args)
  noteFallback('mergeGroups')
  return portableMergeGroups(...args)
}
