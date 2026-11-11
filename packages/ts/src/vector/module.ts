export {
  bindVectorHost,
  holdAdmission,
  releaseLocksHeldBy,
  releasePinsHeldBy,
  requireUsableVectorOptions,
} from '#platform/vector-host'
export { filterSubsetsMatchNothing } from '../engine/query/subset-search'
export { executeHybridSearch, executeVectorSearch, vectorLegWith } from '../engine/query/vector'
export { compactVectors, getVectorMaintenanceStatus, optimizeVectors } from '../engine/vector-maintenance'
export { linearCombination, reciprocalRankFusion, resolveHybridFusion } from '../search/fusion'
export { requireUsableQueryVector } from './query-values'
export { createSharedVectorSearcher } from './shared-field/searcher'
export { openSharedVectorField } from './shared-field/view'
export { createVectorIndex } from './vector-index'
