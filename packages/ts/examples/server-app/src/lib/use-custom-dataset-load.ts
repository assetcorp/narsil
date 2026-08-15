import type { AnyDocument } from '@delali/narsil'
import { useImport, useNarsilClient } from '@delali/narsil/react'
import type { DatasetLoadProgress } from '@delali/narsil-example-shared'
import type { CustomDatasetConfig } from '@delali/narsil-example-shared/components/CustomConfig'
import { languageName } from '@delali/narsil-example-shared/lib/language-names'
import { useCallback } from 'react'

const CUSTOM_DATASET_ID = 'custom' as const

export interface CustomDatasetLoad {
  progress: DatasetLoadProgress | undefined
  start: () => Promise<void>
  cancel: () => void
  reset: () => void
}

/**
 * Sends a corpus the visitor picked in the browser straight to the search
 * server and follows the import task it answers with. The documents are
 * already here, so they never take the detour through this app's own server.
 */
export function useCustomDatasetLoad(config: CustomDatasetConfig | null, onLoaded: () => void): CustomDatasetLoad {
  const client = useNarsilClient()
  const indexName = config?.indexName ?? ''
  const load = useImport(indexName, { onSettled: onLoaded })

  const start = useCallback(async () => {
    if (config === null) return
    const existing = await client.listIndexes()
    if (existing.some(index => index.name === config.indexName)) {
      await client.dropIndex(config.indexName)
    }
    await client.createIndex(config.indexName, {
      schema: config.schema,
      language: languageName(config.language),
    })
    await load.start(config.documents as AnyDocument[])
  }, [client, config, load.start])

  let progress: DatasetLoadProgress | undefined
  if (load.error !== undefined) {
    progress = { datasetId: CUSTOM_DATASET_ID, phase: 'error', error: load.error.message }
  } else if (load.isImporting) {
    progress = {
      datasetId: CUSTOM_DATASET_ID,
      phase: 'indexing',
      indexedDocs: load.progress?.indexed,
      loadedBytes: load.progress?.bytesProcessed,
      totalBytes: load.progress?.bytesTotal,
    }
  } else if (load.result !== undefined) {
    progress = { datasetId: CUSTOM_DATASET_ID, phase: 'complete', indexedDocs: load.result.indexed }
  }

  return { progress, start, cancel: load.cancel, reset: load.reset }
}
