export type { ClientErrorCode, ErrorCode, NarsilErrorCode, ServerErrorCode } from '../errors'
export { ClientErrorCodes, ErrorCodes, NarsilError, ServerErrorCodes } from '../errors'
export {
  ASYNC_IMPORT_CAPABILITY,
  INDEX_LIFECYCLE_CAPABILITY,
  REBUILD_ANALYSIS_CAPABILITY,
  SERVER_CAPABILITIES,
  TASK_CANCEL_CAPABILITY,
  TASK_FILTER_CAPABILITY,
} from '../server/capabilities'
export type {
  CapabilitiesResponse,
  CreateIndexEmbedding,
  ErrorEnvelope,
  HttpIndexConfig,
  ImportError,
  ImportResult,
  TaskListPage,
  TaskListQuery,
  TaskProgress,
  TaskRecord,
  TaskStatus,
  TaskType,
} from '../server/types'
export type { AdminOperations } from './admin'
export type { BulkOperations, ImportSource } from './bulk'
export type { NarsilClient } from './client'
export { createNarsilClient } from './client'
export type { DocumentOperations, PutResult } from './documents'
export type { IndexOperations } from './indexes'
export type { FetchFunction, NarsilClientOptions, RequestOptions } from './options'
export type { SearchOperations } from './search'
export type { ServerOperations, ServerVersion } from './server-info'
export type { TaskOperations, WaitForTaskOptions } from './tasks'
