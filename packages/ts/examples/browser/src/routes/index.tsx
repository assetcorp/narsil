import type { DatasetId, LoadDatasetRequest } from '@delali/narsil-example-shared'
import { useIndexWorkspace } from '@delali/narsil-example-shared'
import { CustomConfig, type CustomDatasetConfig } from '@delali/narsil-example-shared/components/CustomConfig'
import { DatasetCard, datasetMeta } from '@delali/narsil-example-shared/components/datasets/DatasetCard'
import { writeDisplayFields } from '@delali/narsil-example-shared/lib/display-fields'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useCallback, useState } from 'react'
import { ScifactConfig, TmdbConfig, WikiConfig } from '#/components/datasets/DatasetConfigs'
import { useDatasetLoader } from '#/lib/use-dataset-loader'

export const Route = createFileRoute('/')({ component: HomePage })

function HomePage() {
  const { indexes, isLoading, setActiveIndexName, refresh } = useIndexWorkspace()
  const loader = useDatasetLoader(indexes, refresh)
  const navigate = useNavigate()

  const [tmdbTier, setTmdbTier] = useState('10k')
  const [wikiLanguages, setWikiLanguages] = useState<Set<string>>(new Set(['en']))
  const [customConfig, setCustomConfig] = useState<CustomDatasetConfig | null>(null)

  const toggleWikiLanguage = useCallback((code: string) => {
    setWikiLanguages(current => {
      const next = new Set(current)
      if (next.has(code)) {
        next.delete(code)
      } else {
        next.add(code)
      }
      return next
    })
  }, [])

  const handleLoad = useCallback(
    async (datasetId: DatasetId) => {
      let request: LoadDatasetRequest
      switch (datasetId) {
        case 'tmdb':
          request = { datasetId: 'tmdb', tier: tmdbTier }
          break
        case 'wikipedia':
          request = { datasetId: 'wikipedia', languages: [...wikiLanguages] }
          break
        case 'scifact':
          request = { datasetId: 'scifact' }
          break
        case 'custom': {
          if (customConfig === null) return
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

      await loader.load(request)
      if (datasetId === 'custom' && customConfig !== null) {
        writeDisplayFields(customConfig.indexName, customConfig.displayFields)
      }
    },
    [loader, tmdbTier, wikiLanguages, customConfig],
  )

  const handleView = useCallback(
    (datasetId: DatasetId) => {
      const index = indexes.find(entry => entry.datasetId === datasetId)
      if (!index) return
      setActiveIndexName(index.name)
      navigate({ to: '/documents' })
    },
    [indexes, setActiveIndexName, navigate],
  )

  const isLoaded = (datasetId: DatasetId): boolean => indexes.some(index => index.datasetId === datasetId)

  const isBusy = (datasetId: DatasetId): boolean => {
    const progress = loader.progressByDataset.get(datasetId)
    return progress !== undefined && progress.phase !== 'complete' && progress.phase !== 'error'
  }

  const configContent: Record<DatasetId, React.ReactNode> = {
    tmdb: <TmdbConfig tier={tmdbTier} setTier={setTmdbTier} />,
    wikipedia: <WikiConfig selected={wikiLanguages} toggle={toggleWikiLanguage} />,
    scifact: <ScifactConfig />,
    custom: <CustomConfig onReady={setCustomConfig} />,
  }

  return (
    <div>
      <section className="relative border-b border-border bg-surface-raised">
        <div aria-hidden="true" className="pattern-dots absolute inset-0" />
        <div className="relative mx-auto max-w-6xl px-4 py-12 md:py-16">
          <h1 className="text-4xl font-bold tracking-tight md:text-5xl">Datasets</h1>
          <p className="mt-4 max-w-2xl text-lg leading-relaxed text-muted-foreground">
            Choose a dataset to index. Narsil runs entirely in your browser in a Web Worker, and it writes each index to
            IndexedDB, so your data never leaves the machine and it is still here on your next visit.
          </p>
        </div>
      </section>

      <div className="mx-auto max-w-6xl px-4 py-8">
        <div className="stagger-in grid gap-4 sm:grid-cols-2">
          {datasetMeta.map(dataset => (
            <DatasetCard
              key={dataset.id}
              ds={dataset}
              loaded={isLoaded(dataset.id)}
              loading={isBusy(dataset.id)}
              restoring={isLoading}
              progress={loader.progressByDataset.get(dataset.id)}
              onLoad={handleLoad}
              onRemove={loader.remove}
              onView={handleView}
              configContent={configContent[dataset.id]}
              loadDisabled={dataset.id === 'custom' && customConfig === null}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
