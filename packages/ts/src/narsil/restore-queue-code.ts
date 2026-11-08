import { optionalCodeHost } from '../engine/optional-code-host'
import { codeLoader } from '../workers/code-loader'
import type * as RestoreQueue from './restore-queue'

export type RestoreQueueCode = typeof RestoreQueue

const restoreQueue = codeLoader<RestoreQueueCode>(
  () =>
    import('./restore-queue').then(code => {
      code.bindRestoreQueueHost(optionalCodeHost())
      return code
    }),
  'restore',
)

export const loadRestoreQueue = restoreQueue.load
