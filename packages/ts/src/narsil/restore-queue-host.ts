import type { OptionalCodeHost } from '../engine/optional-code-host'
import type * as SuggestionStoreCode from '../query-suggestions/store-leaf'

export { removeDocumentBatch } from '#platform/memory-guarded-writes'
export { emitEngineEvent } from '../engine/events'
export { loadOptionalWrites } from '../engine/optional-writes-code'
export { ErrorCodes, NarsilError } from '../errors'
export { loadStorageCode } from '../persistence/storage-code'
export { attachedRuntimeOf } from '../query-suggestions/attached'
export { unionOfBans } from '../query-suggestions/bans'
export { BUILD_WRITE_BATCH } from '../query-suggestions/constants'
export { clearLeftoversOfName, installSuggestionHooks, startQuerySuggestions } from '../query-suggestions/engine-hooks'
export { RestoredHistory } from '../query-suggestions/restored-history'
export { withState } from '../query-suggestions/stored-state'

export function bindRestoreQueueHost(_host: OptionalCodeHost, _suggestionStore: typeof SuggestionStoreCode): void {}
