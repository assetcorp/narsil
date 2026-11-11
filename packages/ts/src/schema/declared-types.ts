import { MAX_NESTING_DEPTH } from './constants'
import { isPlainObject } from './validator/shared'

function mayDeclare(schema: unknown, typeName: string, depth: number): boolean {
  if (!isPlainObject(schema) || depth > MAX_NESTING_DEPTH + 1) return false
  for (const type of Object.values(schema)) {
    if (typeof type === 'string' ? type.includes(typeName) : mayDeclare(type, typeName, depth + 1)) return true
  }
  return false
}

export function schemaMayDeclare(schema: unknown, typeName: string): boolean {
  return mayDeclare(schema, typeName, 1)
}
