import { createPatternWorkMeter, type SharedPatternWork } from '../../../core/pattern-index/work-meter'
import type { IndexConfig, SchemaDefinition } from '../../../types/schema'
import { createRequestId } from '../../../workers/protocol'

export const schema: SchemaDefinition = {
  title: 'string' as const,
  score: 'number' as const,
}

export const config: IndexConfig = {
  schema,
  language: 'english',
}

export function reqId(): string {
  return createRequestId()
}

export function patternWork(): SharedPatternWork {
  return createPatternWorkMeter().fork(1).shared
}
