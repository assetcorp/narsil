import { useEffect, useMemo, useState } from 'react'
import type { NarsilBackend } from '../backend'
import {
  filterableFields,
  flattenSchemaLeaves,
  isVectorType,
  type SchemaField,
  type SchemaLeaf,
  sortableFieldPaths,
} from '../lib/field-filters'

export interface IndexSchema {
  leaves: SchemaLeaf[]
  fields: SchemaField[]
  sortablePaths: Set<string>
  vectorPaths: Set<string>
  isLoading: boolean
}

const NO_LEAVES: SchemaLeaf[] = []

export function useIndexSchema(backend: NarsilBackend, indexName: string | null): IndexSchema {
  const [leaves, setLeaves] = useState<SchemaLeaf[]>(NO_LEAVES)
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    if (!indexName) {
      setLeaves(NO_LEAVES)
      setIsLoading(false)
      return
    }

    let isCancelled = false
    setIsLoading(true)
    backend
      .getStats(indexName)
      .then(stats => {
        if (isCancelled) return
        setLeaves(flattenSchemaLeaves(stats.schema))
      })
      .catch(() => {
        if (isCancelled) return
        setLeaves(NO_LEAVES)
      })
      .finally(() => {
        if (!isCancelled) setIsLoading(false)
      })

    return () => {
      isCancelled = true
    }
  }, [backend, indexName])

  const fields = useMemo(() => filterableFields(leaves), [leaves])
  const sortablePaths = useMemo(() => sortableFieldPaths(fields), [fields])
  const vectorPaths = useMemo(
    () => new Set(leaves.filter(leaf => isVectorType(leaf.type)).map(leaf => leaf.path)),
    [leaves],
  )

  return { leaves, fields, sortablePaths, vectorPaths, isLoading }
}
