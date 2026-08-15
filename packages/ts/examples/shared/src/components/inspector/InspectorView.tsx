import type { IndexStats, MemoryStats, PartitionStatsResult, VectorMaintenanceResult } from '@delali/narsil'
import { lazy, Suspense, useCallback, useState } from 'react'
import { useActiveIndex, useIndexWorkspace } from '../../workspace'
import { IndexSelector } from '../IndexSelector'
import { Button } from '../ui/button'
import { Skeleton } from '../ui/skeleton'
import { SchemaDisplay } from './SchemaDisplay'
import { StatsTab } from './StatsTab'

const VectorTab = lazy(() => import('./VectorTab'))

const NO_PARTITIONS: PartitionStatsResult[] = []
const NO_VECTOR_FIELDS: VectorMaintenanceResult[] = []

export interface InspectorViewProps {
  stats: IndexStats | undefined
  partitions: PartitionStatsResult[] | undefined
  memory: MemoryStats | undefined
  vectorFields: VectorMaintenanceResult[] | undefined
  isLoading: boolean
}

export function InspectorView({ stats, partitions, memory, vectorFields, isLoading }: InspectorViewProps) {
  const { activeIndexName } = useIndexWorkspace()
  const activeIndex = useActiveIndex()
  const [activeTab, setActiveTab] = useState<'stats' | 'schema' | 'vectors'>('stats')

  const handleStatsTab = useCallback(() => {
    setActiveTab('stats')
  }, [])

  const handleSchemaTab = useCallback(() => {
    setActiveTab('schema')
  }, [])

  const handleVectorsTab = useCallback(() => {
    setActiveTab('vectors')
  }, [])

  if (activeIndexName === null) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="mb-2 text-3xl font-bold tracking-tight">Index Inspector</h1>
        <p className="text-sm text-muted-foreground">
          Load a dataset from the Datasets tab to inspect index structure, memory stats, and vector space.
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6">
        <h1 className="mb-1 text-3xl font-bold tracking-tight">Index Inspector</h1>
        {activeIndex ? (
          <p className="text-sm text-muted-foreground">
            Inspecting <span className="font-mono font-medium text-foreground">{activeIndex.name}</span>
          </p>
        ) : null}
      </div>

      <IndexSelector />

      <div className="mb-4 flex gap-1">
        <Button variant={activeTab === 'stats' ? 'default' : 'outline'} size="sm" onClick={handleStatsTab}>
          Stats
        </Button>
        <Button variant={activeTab === 'schema' ? 'default' : 'outline'} size="sm" onClick={handleSchemaTab}>
          Schema
        </Button>
        <Button variant={activeTab === 'vectors' ? 'default' : 'outline'} size="sm" onClick={handleVectorsTab}>
          Vectors
        </Button>
      </div>

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Skeleton className="h-24 rounded-lg" />
          <Skeleton className="h-24 rounded-lg" />
          <Skeleton className="h-24 rounded-lg" />
          <Skeleton className="h-24 rounded-lg" />
        </div>
      ) : null}

      {!isLoading && stats !== undefined && activeTab === 'stats' ? (
        <StatsTab
          stats={stats}
          partitionStats={partitions ?? NO_PARTITIONS}
          memoryStats={memory ?? null}
          vectorFields={vectorFields ?? NO_VECTOR_FIELDS}
        />
      ) : null}

      {!isLoading && stats !== undefined && activeTab === 'schema' ? <SchemaDisplay schema={stats.schema} /> : null}

      {activeTab === 'vectors' ? (
        <Suspense
          fallback={
            <div className="py-12 text-center text-sm text-muted-foreground">Loading vector visualization...</div>
          }
        >
          <VectorTab indexName={activeIndexName} />
        </Suspense>
      ) : null}
    </div>
  )
}
