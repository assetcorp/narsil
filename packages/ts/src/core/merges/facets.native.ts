import { loadNativeCore } from '#platform/native-core'
import { nativeSearchCoreIsEnabled, noteFallback } from '../../vector/native/backend'
import { mergeFacets as portableMergeFacets } from './facets'

export const mergeFacets: typeof portableMergeFacets = (...args) => {
  if (!nativeSearchCoreIsEnabled()) return portableMergeFacets(...args)
  const core = loadNativeCore()
  if (core !== null) return core.mergeFacets(...args)
  noteFallback('mergeFacets')
  return portableMergeFacets(...args)
}
