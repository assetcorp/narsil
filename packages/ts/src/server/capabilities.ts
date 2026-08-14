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
]
