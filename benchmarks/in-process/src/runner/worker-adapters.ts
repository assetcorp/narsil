import {
  createMiniSearchFullSchemaAdapter,
  createMiniSearchSerializableAdapter,
  createMiniSearchTextOnlyAdapter,
} from '../adapters/minisearch'
import {
  createNarsilFullSchemaAdapter,
  createNarsilSerializableAdapter,
  createNarsilTextOnlyAdapter,
  createNarsilVectorAdapter,
} from '../adapters/narsil'
import {
  createOramaFullSchemaAdapter,
  createOramaSerializableAdapter,
  createOramaTextOnlyAdapter,
  createOramaVectorAdapter,
} from '../adapters/orama'
import type { SearchEngine, SerializableEngine, VectorSearchEngine } from '../types'
import type { EngineId, TextJobSpec } from './jobs'

export function textAdapter(engine: EngineId, adapter: TextJobSpec['adapter']): SearchEngine {
  if (engine === 'narsil') {
    return adapter === 'text-only' ? createNarsilTextOnlyAdapter() : createNarsilFullSchemaAdapter()
  }
  if (engine === 'orama') {
    return adapter === 'text-only' ? createOramaTextOnlyAdapter() : createOramaFullSchemaAdapter()
  }
  return adapter === 'text-only' ? createMiniSearchTextOnlyAdapter() : createMiniSearchFullSchemaAdapter()
}

export function vectorAdapter(engine: EngineId, dim: number): VectorSearchEngine {
  if (engine === 'narsil') return createNarsilVectorAdapter(dim)
  if (engine === 'orama') return createOramaVectorAdapter(dim)
  throw new Error(`vector adapter for engine "${engine}" is not available`)
}

export function serializableAdapter(engine: EngineId): SerializableEngine {
  if (engine === 'narsil') return createNarsilSerializableAdapter()
  if (engine === 'orama') return createOramaSerializableAdapter()
  return createMiniSearchSerializableAdapter()
}

export function fullSchemaAdapter(engine: EngineId): SearchEngine {
  if (engine === 'narsil') return createNarsilFullSchemaAdapter()
  if (engine === 'orama') return createOramaFullSchemaAdapter()
  return createMiniSearchFullSchemaAdapter()
}
