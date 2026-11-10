import { optionalCodeHost } from '../engine/optional-code-host'
import { loadSuggestionStore } from '../query-suggestions/store-code'
import { codeLoader } from '../workers/code-loader'
import type * as RestoreQueue from './restore-queue'

export type RestoreQueueCode = typeof RestoreQueue

const restoreQueue = codeLoader<RestoreQueueCode>(async () => {
  const [suggestionStore, code] = await Promise.all([loadSuggestionStore(), import('./restore-queue')])
  code.bindRestoreQueueHost(optionalCodeHost(), suggestionStore)
  return code
}, 'restore')

export const loadRestoreQueue = restoreQueue.load
