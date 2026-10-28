import { MAX_NESTING_DEPTH } from '../schema/constants'
import { isPlainObject } from '../schema/validator/shared'
import type * as VectorModule from '../vector/module'

export type VectorCode = typeof VectorModule

const VECTOR_TYPE_NAME = 'vector'

let loaded: VectorCode | null = null
let loading: Promise<VectorCode> | null = null

export function loadedVectorCode(): VectorCode | null {
  return loaded
}

export function requireLoadedVectorCode(): VectorCode {
  if (loaded === null) throw new Error('The engine reached vector code before it loaded that code')
  return loaded
}

export function loadVectorCode(): Promise<VectorCode> {
  if (loaded !== null) return Promise.resolve(loaded)
  if (loading === null) {
    loading = import('../vector/module').then(
      code => {
        loaded = code
        return code
      },
      (err: unknown) => {
        loading = null
        throw err
      },
    )
  }
  return loading
}

function mayDeclareVectorField(schema: unknown, depth: number): boolean {
  if (!isPlainObject(schema) || depth > MAX_NESTING_DEPTH + 1) return false
  for (const type of Object.values(schema)) {
    if (typeof type === 'string' ? type.includes(VECTOR_TYPE_NAME) : mayDeclareVectorField(type, depth + 1)) {
      return true
    }
  }
  return false
}

export function loadVectorCodeFor(schema: unknown): Promise<VectorCode> | null {
  if (loaded !== null || !mayDeclareVectorField(schema, 1)) return null
  return loadVectorCode()
}
