import type { DatasetId, LoadDatasetRequest } from '@delali/narsil-example-shared'
import { useIndexWorkspace } from '@delali/narsil-example-shared'
import { CustomConfig, type CustomDatasetConfig } from '@delali/narsil-example-shared/components/CustomConfig'
import { DatasetCard, datasetMeta } from '@delali/narsil-example-shared/components/datasets/DatasetCard'
import { writeDisplayFields } from '@delali/narsil-example-shared/lib/display-fields'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useCallback, useState } from 'react'
import { ScifactConfig, TmdbConfig, WikiConfig } from '#/components/datasets/DatasetConfigs'
import { useCustomDatasetLoad } from '#/lib/use-custom-dataset-load'
import { useDatasetTasks } from '#/lib/use-dataset-tasks'

export const Route = createFileRoute('/')({ component: HomePage })

function HomePage() {
  const { indexes, isLoading, error, setActiveIndexName, refresh } = useIndexWorkspace()
  const tasks = useDatasetTasks(indexes, refresh)
  const navigate = useNavigate()

  const [tmdbTier, setTmdbTier] = useState('10k')
  const [wikiLanguages, setWikiLanguages] = useState<Set<string>>(new Set(['en']))
  const [customConfig, setCustomConfig] = useState<CustomDatasetConfig | null>(null)
  const custom = useCustomDatasetLoad(customConfig, refresh)

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
      if (datasetId === 'custom') {
        if (customConfig === null) return
        await custom.start()
        writeDisplayFields(customConfig.indexName, customConfig.displayFields)
        return
      }

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
      }
      await tasks.start(request)
    },
    [tasks, custom, tmdbTier, wikiLanguages, customConfig],
  )

  const handleRemove = useCallback(
    async (datasetId: DatasetId) => {
      if (datasetId === 'custom') custom.reset()
      await tasks.remove(datasetId)
    },
    [tasks, custom],
  )

  const handleCancel = useCallback(
    (datasetId: DatasetId) => {
      if (datasetId === 'custom') {
        custom.cancel()
        return
      }
      tasks.cancel(datasetId)
    },
    [tasks, custom],
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

  const progressFor = (datasetId: DatasetId) =>
    datasetId === 'custom' ? custom.progress : tasks.progressByDataset.get(datasetId)

  const isBusy = (datasetId: DatasetId): boolean => {
    const progress = progressFor(datasetId)
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
            Choose a dataset to index. Each load runs as a task on the Narsil server, so it carries on when you leave
            this page, and the indexes it builds survive a restart.
          </p>
        </div>
      </section>

      <div className="mx-auto max-w-6xl px-4 py-8">
        <div className="stagger-in grid gap-4 sm:grid-cols-2">
          {datasetMeta.map(dataset => (
            <DatasetCard
              key={dataset.id}
              ds={dataset}
              loaded={indexes.some(index => index.datasetId === dataset.id)}
              loading={isBusy(dataset.id)}
              restoring={isLoading}
              progress={progressFor(dataset.id)}
              onLoad={handleLoad}
              onRemove={handleRemove}
              onView={handleView}
              onCancel={handleCancel}
              configContent={configContent[dataset.id]}
              loadDisabled={dataset.id === 'custom' && customConfig === null}
              serverUnavailable={error !== null}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
