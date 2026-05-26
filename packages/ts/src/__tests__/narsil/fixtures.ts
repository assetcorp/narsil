import type { IndexConfig, SchemaDefinition } from '../../types/schema'

export const schema: SchemaDefinition = {
  title: 'string' as const,
  category: 'enum' as const,
  price: 'number' as const,
}

export const indexConfig: IndexConfig = {
  schema,
  language: 'english',
}
