import { useEffect, useState } from 'react'
import { type DisplayFieldMapping, readDisplayFields } from '../lib/display-fields'

export function useDisplayFields(indexName: string | null): DisplayFieldMapping | null {
  const [mapping, setMapping] = useState<DisplayFieldMapping | null>(null)

  useEffect(() => {
    setMapping(indexName === null ? null : readDisplayFields(indexName))
  }, [indexName])

  return mapping
}
