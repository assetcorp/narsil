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
