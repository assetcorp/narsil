import { ErrorCodes, NarsilError } from '#platform/worker-copies-host'
import type { WorkerConfig } from '../../types/config'
import { DEFAULT_WORKER_SILENCE_BEFORE_PROBE_MS, DEFAULT_WORKER_SILENCE_BEFORE_RETIREMENT_MS } from './constants'

function requireWholeNumber(field: string, value: number | undefined, minimum: number): void {
  if (value === undefined || (Number.isSafeInteger(value) && value >= minimum)) return
  throw new NarsilError(ErrorCodes.CONFIG_INVALID, `workers.${field} must be a whole number of at least ${minimum}`, {
    [field]: value,
  })
}

export function validateWorkerLiveness(workers: WorkerConfig): void {
  requireWholeNumber('silenceBeforeProbeMs', workers.silenceBeforeProbeMs, 1)
  requireWholeNumber('silenceBeforeRetirementMs', workers.silenceBeforeRetirementMs, 1)
  requireWholeNumber('maxThreadsLeftRunning', workers.maxThreadsLeftRunning, 0)
  const beforeProbe = workers.silenceBeforeProbeMs ?? DEFAULT_WORKER_SILENCE_BEFORE_PROBE_MS
  const beforeRetirement = workers.silenceBeforeRetirementMs ?? DEFAULT_WORKER_SILENCE_BEFORE_RETIREMENT_MS
  if (beforeProbe < beforeRetirement) return
  throw new NarsilError(
    ErrorCodes.CONFIG_INVALID,
    'workers.silenceBeforeProbeMs must be less than workers.silenceBeforeRetirementMs, so that a worker gets a probe before the engine retires it',
    { silenceBeforeProbeMs: beforeProbe, silenceBeforeRetirementMs: beforeRetirement },
  )
}
