import type { ServerLimits } from '@delali/narsil/server'
import { ENGINE_MAX_RERANK_WINDOW } from './constants'
import type { VariableReader } from './variables'

type LimitField = keyof ServerLimits

interface LimitVariable {
  variable: string
  min: number
  max?: number
}

const UNBOUNDED_AT_ZERO = 0
const COUNTED = 1

export const LIMIT_VARIABLES: Readonly<Record<LimitField, LimitVariable>> = {
  maxBodyBytes: { variable: 'NARSIL_LIMIT_MAX_BODY_BYTES', min: UNBOUNDED_AT_ZERO },
  maxImportBytes: { variable: 'NARSIL_LIMIT_MAX_IMPORT_BYTES', min: UNBOUNDED_AT_ZERO },
  maxRestoreBytes: { variable: 'NARSIL_LIMIT_MAX_RESTORE_BYTES', min: UNBOUNDED_AT_ZERO },
  maxLineBytes: { variable: 'NARSIL_LIMIT_MAX_LINE_BYTES', min: UNBOUNDED_AT_ZERO },
  importBatchSize: { variable: 'NARSIL_LIMIT_IMPORT_BATCH_SIZE', min: COUNTED },
  maxConcurrentRequests: { variable: 'NARSIL_LIMIT_MAX_CONCURRENT_REQUESTS', min: UNBOUNDED_AT_ZERO },
  maxBodyBytesInFlightFraction: { variable: 'NARSIL_LIMIT_MAX_BODY_BYTES_IN_FLIGHT_FRACTION', min: 0 },
  maxResultWindow: { variable: 'NARSIL_LIMIT_MAX_RESULT_WINDOW', min: COUNTED },
  maxRerankWindow: { variable: 'NARSIL_LIMIT_MAX_RERANK_WINDOW', min: COUNTED, max: ENGINE_MAX_RERANK_WINDOW },
  maxFetchDocuments: { variable: 'NARSIL_LIMIT_MAX_FETCH_DOCUMENTS', min: COUNTED },
  maxImportErrors: { variable: 'NARSIL_LIMIT_MAX_IMPORT_ERRORS', min: UNBOUNDED_AT_ZERO },
  maxTaskPageSize: { variable: 'NARSIL_LIMIT_MAX_TASK_PAGE_SIZE', min: COUNTED },
  maxConcurrentTasks: { variable: 'NARSIL_LIMIT_MAX_CONCURRENT_TASKS', min: UNBOUNDED_AT_ZERO },
}

const FRACTION_FIELD: LimitField = 'maxBodyBytesInFlightFraction'
const MAX_FRACTION = 1

export function readLimits(reader: VariableReader): ServerLimits {
  const limits: ServerLimits = {}
  for (const field of Object.keys(LIMIT_VARIABLES) as LimitField[]) {
    const { variable, min, max } = LIMIT_VARIABLES[field]
    const value =
      field === FRACTION_FIELD
        ? reader.decimal(variable, min, MAX_FRACTION)
        : reader.wholeNumber(variable, max === undefined ? { min } : { min, max })
    if (value !== undefined) limits[field] = value
  }
  return limits
}

export function limitVariableOf(field: unknown): string | null {
  if (typeof field !== 'string' || !Object.hasOwn(LIMIT_VARIABLES, field)) return null
  return LIMIT_VARIABLES[field as LimitField].variable
}
