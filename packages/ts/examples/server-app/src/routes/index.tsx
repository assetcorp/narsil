import type { DatasetId, DatasetLoadProgress, LoadDatasetRequest } from '@delali/narsil-example-shared'
import { useAppDispatch, useAppState, useBackend } from '@delali/narsil-example-shared'
import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { CustomConfig, type CustomDatasetConfig } from '#/components/datasets/CustomConfig'
import { DatasetCard, datasetMeta } from '#/components/datasets/DatasetCard'
import { ScifactConfig, TmdbConfig, WikiConfig } from '#/components/datasets/DatasetConfigs'
import { useEngineStatus } from '#/lib/engine-status'

export const Route = createFileRoute('/')({ component: HomePage })

function HomePage() {
  const backend = useBackend()
  const state = useAppState()
  const dispatch = useAppDispatch()
  const engineStatus = useEngineStatus()

  const [tmdbTier, setTmdbTier] = useState('10k')
  const [wikiLangs, setWikiLangs] = useState<Set<string>>(new Set(['en']))
  const [customConfig, setCustomConfig] = useState<CustomDatasetConfig | null>(null)

  useEffect(() => {
    const handler = (progress: DatasetLoadProgress) => {
      dispatch({ type: 'SET_LOADING', payload: progress })

      if (progress.phase === 'error') {
        dispatch({
          type: 'LOADING_ERROR',
          payload: { datasetId: progress.datasetId, error: progress.error ?? 'Unknown error' },
        })
      }
    }

    backend.subscribe('progress', handler)
    return () => backend.unsubscribe('progress', handler)
  }, [backend, dispatch])

  function toggleWikiLang(code: string) {
    setWikiLangs(prev => {
      const next = new Set(prev)
      if (next.has(code)) {
        next.delete(code)
      } else {
        next.add(code)
      }
      return next
    })
  }

  const handleLoad = useCallback(
    async (datasetId: DatasetId) => {
      let request: LoadDatasetRequest
      switch (datasetId) {
        case 'tmdb':
          request = { datasetId: 'tmdb', tier: tmdbTier }
          break
        case 'wikipedia':
          request = { datasetId: 'wikipedia', languages: [...wikiLangs] }
          break
        case 'scifact':
          request = { datasetId: 'scifact' }
          break
        case 'custom': {
          if (!customConfig) return
          request = {
            datasetId: 'custom',
            documents: customConfig.documents,
            schema: customConfig.schema,
            indexName: customConfig.indexName,
            language: customConfig.language,
          }
          break
        }
      }

      dispatch({
        type: 'SET_LOADING',
        payload: { datasetId, phase: 'fetching' },
      })

      try {
        await backend.loadDataset(request)
        const indexes = await backend.listIndexes()
        for (const idx of indexes) {
          if (
            (datasetId === 'tmdb' && idx.name.startsWith('tmdb-')) ||
            (datasetId === 'wikipedia' && idx.name.startsWith('wikipedia-')) ||
            (datasetId === 'scifact' && idx.name === 'scifact') ||
            (datasetId === 'custom' && customConfig && idx.name === customConfig.indexName)
          ) {
            dispatch({
              type: 'INDEX_READY',
              payload: {
                name: idx.name,
                datasetId,
                documentCount: idx.documentCount,
                language: idx.language,
              },
            })
          }
        }
      } catch (err) {
        dispatch({
          type: 'LOADING_ERROR',
          payload: { datasetId, error: err instanceof Error ? err.message : String(err) },
        })
      }
    },
    [backend, dispatch, tmdbTier, wikiLangs, customConfig],
  )

  const handleRemove = useCallback(
    async (datasetId: DatasetId) => {
      const indexesForDataset = state.indexes.filter(idx => idx.datasetId === datasetId)
      for (const idx of indexesForDataset) {
        try {
          await backend.deleteIndex(idx.name)
          dispatch({ type: 'REMOVE_INDEX', payload: idx.name })
        } catch {
          // Index may already be gone
        }
      }
    },
    [backend, dispatch, state.indexes],
  )

  function isLoaded(datasetId: DatasetId): boolean {
    return state.indexes.some(idx => idx.datasetId === datasetId)
  }

  function isLoading(datasetId: DatasetId): boolean {
    const progress = state.loadingDatasets.get(datasetId)
    return !!progress && progress.phase !== 'complete' && progress.phase !== 'error'
  }

  function isLoadDisabled(datasetId: DatasetId): boolean {
    if (datasetId === 'custom') return !customConfig
    return false
  }

  const configContent: Record<DatasetId, React.ReactNode> = {
    tmdb: <TmdbConfig tier={tmdbTier} setTier={setTmdbTier} />,
    wikipedia: <WikiConfig selected={wikiLangs} toggle={toggleWikiLang} />,
    scifact: <ScifactConfig />,
    custom: <CustomConfig onReady={setCustomConfig} />,
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <section className="mb-8">
        <h1 className="mb-2 font-serif text-3xl tracking-tight">Datasets</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Choose a dataset to index. Narsil runs on the server with filesystem persistence, so indexed data survives
          restarts. Configure the tier and fields, then explore search, relevance tuning, and quality benchmarks.
        </p>
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        {datasetMeta.map(ds => (
          <DatasetCard
            key={ds.id}
            ds={ds}
            loaded={isLoaded(ds.id)}
            loading={isLoading(ds.id)}
            restoring={state.restoring}
            enginePhase={engineStatus.phase}
            progress={state.loadingDatasets.get(ds.id)}
            onLoad={handleLoad}
            onRemove={handleRemove}
            configContent={configContent[ds.id]}
            loadDisabled={isLoadDisabled(ds.id)}
          />
        ))}
      </div>
    </div>
  )
}
