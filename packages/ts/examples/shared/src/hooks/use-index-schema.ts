import type { IndexStats } from '@delali/narsil'
import { useMemo } from 'react'
import {
  filterableFields,
  flattenSchemaLeaves,
  isVectorType,
  type SchemaField,
  type SchemaLeaf,
  searchableFieldPaths,
  sortableFieldPaths,
} from '../lib/field-filters'

export interface IndexSchemaView {
  leaves: SchemaLeaf[]
  fields: SchemaField[]
  searchablePaths: string[]
  sortablePaths: Set<string>
  vectorPaths: Set<string>
}

const NO_LEAVES: SchemaLeaf[] = []
const NO_FIELDS: SchemaField[] = []
const NO_PATHS: string[] = []

export const EMPTY_INDEX_SCHEMA: IndexSchemaView = {
  leaves: NO_LEAVES,
  fields: NO_FIELDS,
  searchablePaths: NO_PATHS,
  sortablePaths: new Set<string>(),
  vectorPaths: new Set<string>(),
}

export function deriveIndexSchema(schema: IndexStats['schema'] | undefined): IndexSchemaView {
  if (schema === undefined) return EMPTY_INDEX_SCHEMA
  const leaves = flattenSchemaLeaves(schema)
  const fields = filterableFields(leaves)
  return {
    leaves,
    fields,
    searchablePaths: searchableFieldPaths(leaves),
    sortablePaths: sortableFieldPaths(fields),
    vectorPaths: new Set(leaves.filter(leaf => isVectorType(leaf.type)).map(leaf => leaf.path)),
  }
}

export function useIndexSchema(stats: IndexStats | undefined): IndexSchemaView {
  return useMemo(() => deriveIndexSchema(stats?.schema), [stats?.schema])
}
