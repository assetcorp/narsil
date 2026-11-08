export type { BackupListing, BackupSummary, DamagedBackup } from '../distribution/backups/types'
export type { ClientErrorCode, ErrorCode, NarsilErrorCode, ServerErrorCode } from '../errors'
export { ClientErrorCodes, ErrorCodes, isNarsilError, NarsilError, ServerErrorCodes } from '../errors'
export {
  ASYNC_IMPORT_CAPABILITY,
  BM25_TUNING_CAPABILITY,
  CHANGE_ANALYSIS_CAPABILITY,
  DOCUMENT_EXPORT_CAPABILITY,
  INDEX_LIFECYCLE_CAPABILITY,
  REBUILD_ANALYSIS_CAPABILITY,
  SERVER_CAPABILITIES,
  SYNONYMS_CAPABILITY,
  TASK_CANCEL_CAPABILITY,
  TASK_FILTER_CAPABILITY,
} from '../server/capabilities'
export type {
  BackupListResponse,
  CapabilitiesResponse,
  ChangeAnalysisBody,
  CreateIndexEmbedding,
  ErrorDetail,
  ErrorEnvelope,
  HttpIndexConfig,
  ImportError,
  ImportResult,
  MemoryStatsResponse,
  RestoreBackupBody,
  TaskListPage,
  TaskListQuery,
  TaskProgress,
  TaskRecord,
  TaskStatus,
  TaskStepProgress,
  TaskType,
} from '../server/types'
export type { SnapshotOptions } from '../types/engine'
export type {
  ManualQuerySuggestion,
  QuerySuggestionPreviewEntry,
  QuerySuggestionsBuild,
  QuerySuggestionsBuildTrigger,
  QuerySuggestionsPreview,
  QuerySuggestionsSetting,
  QuerySuggestionsStatus,
  RecordQueryOutcome,
  RecordQueryResult,
} from '../types/query-suggestions'
export type { SyncSetting, SyncStatus } from '../types/sync'
export type { AdminOperations } from './admin'
export type { BackupOperations } from './backups'
export type { BulkOperations, ImportSource } from './bulk'
export type { NarsilClient } from './client'
export { createNarsilClient } from './client'
export type { DocumentOperations, PutResult } from './documents'
export type { IndexOperations } from './indexes'
export type { FetchFunction, NarsilClientOptions, RequestOptions } from './options'
export type { QuerySuggestionOperations } from './query-suggestions'
export type { SearchOperations } from './search'
export type { ServerOperations, ServerVersion } from './server-info'
export type { SyncSettingOperations, SyncSnapshotDownload, SyncSnapshotResume } from './sync'
export type { TaskOperations, WaitForTaskOptions } from './tasks'
