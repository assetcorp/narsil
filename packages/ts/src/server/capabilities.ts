/**
 * Marks that `POST /indexes/{name}/documents/_import` accepts `?async=true` and
 * answers with a task record.
 *
 * @public
 */
export const ASYNC_IMPORT_CAPABILITY = 'documents.import.async'

/**
 * Marks that `POST /tasks/{id}/_cancel` asks a running task to stop.
 *
 * @public
 */
export const TASK_CANCEL_CAPABILITY = 'tasks.cancel'

/**
 * Marks that `GET /tasks` filters by index, type, and status, and pages through
 * `from` and `limit`.
 *
 * @public
 */
export const TASK_FILTER_CAPABILITY = 'tasks.filter'

/**
 * Marks that `POST /indexes/{name}/_rebuild-analysis` reanalyses an index whose
 * language module moved on.
 *
 * @public
 */
export const REBUILD_ANALYSIS_CAPABILITY = 'indexes.rebuildAnalysis'

/**
 * Marks that `POST /indexes/{name}/_open` and `POST /indexes/{name}/_close`
 * load and release an index's server memory.
 *
 * @public
 */
export const INDEX_LIFECYCLE_CAPABILITY = 'indexes.lifecycle'

/**
 * Marks a server that answers `GET /indexes/{name}/export` with a stream of a
 * document export and imports an export sent to `POST /indexes/{name}/import`
 * in a task.
 *
 * @public
 */
export const DOCUMENT_EXPORT_CAPABILITY = 'indexes.documentExport'

/**
 * Marks a server that reads the synonym set of an index at
 * `GET /indexes/{name}/synonyms` and replaces it at
 * `POST /indexes/{name}/synonyms`.
 *
 * @public
 */
export const SYNONYMS_CAPABILITY = 'indexes.synonyms'

/**
 * Marks a server that replaces the BM25 setting of an index at
 * `POST /indexes/{name}/bm25`.
 *
 * @public
 */
export const BM25_TUNING_CAPABILITY = 'indexes.bm25'

/**
 * Every capability this server announces at `/capabilities`.
 *
 * A client reads this list to find out whether an optional route or mode is
 * available before it sends a request, because a server that predates one of
 * them answers 404 rather than explaining itself.
 *
 * @public
 */
export const SERVER_CAPABILITIES: readonly string[] = [
  ASYNC_IMPORT_CAPABILITY,
  TASK_CANCEL_CAPABILITY,
  TASK_FILTER_CAPABILITY,
  REBUILD_ANALYSIS_CAPABILITY,
  INDEX_LIFECYCLE_CAPABILITY,
  DOCUMENT_EXPORT_CAPABILITY,
  SYNONYMS_CAPABILITY,
  BM25_TUNING_CAPABILITY,
]
