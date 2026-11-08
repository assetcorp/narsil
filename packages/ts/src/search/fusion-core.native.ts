import { loadNativeCore } from '#platform/native-core'
import { nativeSearchCoreIsEnabled, noteFallback } from '../vector/native/backend'
import { fuse as portableFuse } from './fusion-core'

export const fuse: typeof portableFuse = (
  strategy,
  k,
  alpha,
  textKeys,
  textScores,
  vectorKeys,
  vectorScores,
  idRanks,
  keys,
  scores,
) => {
  if (!nativeSearchCoreIsEnabled()) {
    return portableFuse(strategy, k, alpha, textKeys, textScores, vectorKeys, vectorScores, idRanks, keys, scores)
  }
  const core = loadNativeCore()
  if (core !== null) {
    return core.fuse(strategy, k, alpha, textKeys, textScores, vectorKeys, vectorScores, idRanks, keys, scores)
  }
  noteFallback('fuse')
  return portableFuse(strategy, k, alpha, textKeys, textScores, vectorKeys, vectorScores, idRanks, keys, scores)
}
