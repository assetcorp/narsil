import type { OptionalCodeHost } from '../engine/optional-code-host'

export { removeDocumentBatch } from '#platform/memory-guarded-writes'
export { emitEngineEvent } from '../engine/events'
export { ErrorCodes, NarsilError } from '../errors'
export { loadStorageCode } from '../persistence/storage-code'
export { attachedRuntimeOf } from '../query-suggestions/attached'
export { unionOfBans } from '../query-suggestions/bans'
export { clearLeftoversOfName, installSuggestionHooks } from '../query-suggestions/engine-hooks'
export { RestoredHistory } from '../query-suggestions/restored-history'
export { withState } from '../query-suggestions/stored-state'

export function bindRestoreQueueHost(_host: OptionalCodeHost): void {}
