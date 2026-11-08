import type { OptionalCodeHost } from '../engine/optional-code-host'
import type * as SuggestionStoreCode from './store-leaf'

export { encode } from '@msgpack/msgpack'
export { spawnNodeWorker } from '#platform/node-worker'
export { compareCodePoints } from '../core/ordering'
export { emitEngineEvent } from '../engine/events'
export { createEngineIndex } from '../engine/index-lifecycle'
export { withOpenIndex } from '../engine/serial-index-update'
export { oneSyncChangeAtATime } from '../engine/sync/serial'
export { emitWriteEventAfter } from '../engine/write-events'
export { ErrorCodes, NarsilError } from '../errors'
export { loadDigest } from '../persistence/digest-code'
export { crc32 } from '../serialization/crc32'
export { openChecksummedEnvelope, packEnvelopeWithChecksum } from '../serialization/envelope-file'
export { decode } from '../serialization/msgpack'
export { attachedRuntimeOf, attachRuntime } from './attached'
export { banListFromInput, normaliseBan } from './bans'
export {
  BUILD_LIST_PAGE,
  BUILD_WRITE_BATCH,
  BYTES_PER_MIB,
  DAY_MS,
  DEFAULT_PREVIEW_LIMIT,
  HISTORY_SWEEP_INTERVAL_MS,
  KEY_FINGERPRINT_BYTES,
  KEY_FINGERPRINT_LABEL,
  MAX_MANUAL_SUGGESTION_COUNT,
  MAX_PREVIEW_LIMIT,
  MAX_SOURCE_INDEX_NAME_LENGTH,
  MAX_TIMER_DELAY_MS,
  MIN_KEY_BYTES,
  MS_PER_SECOND,
  SCHEDULE_OFF,
  SCRAMBLED_ID_BYTES,
} from './constants'
export { openCountsFile, sameBytes } from './counts-file'
export { DayStore, dayOf } from './day-store'
export { installSuggestionHooks } from './engine-hooks'
export {
  buildRecordKey,
  historyFileOf,
  historyFilesOf,
  listHistoryFolder,
  removeHistoryFolder,
  removeRestoreLeftovers,
} from './history-files'
export { GROUP_FORMAT, SUGGESTIONS_INDEX_INFIX } from './index-names/constants'
export { acceptedPhrase, isGroup, isPerson } from './phrase'
export { RestoredHistory } from './restored-history'
export { latestMatchAtOrBefore, nextMatchAfter, parseSchedule } from './schedule'
export { invalidSetting, requireFieldsInSchema, resolveSetting, validateSetting } from './setting'
export { withState } from './stored-state'

export function bindSuggestionsHost(_host: OptionalCodeHost, _suggestionStore: typeof SuggestionStoreCode): void {}
