import { type Dispatch, lazy, Suspense, useCallback, useEffect, useState } from 'react'
import type { IndexStats, NarsilBackend, PartitionStats } from '../../backend'
import type { AppAction, AppState } from '../../types'
import { Button } from '../ui/button'
import { Skeleton } from '../ui/skeleton'
import { SchemaDisplay } from './SchemaDisplay'
import { StatsTab } from './StatsTab'

const VectorTab = lazy(() => import('./VectorTab'))

interface InspectorViewProps {
  backend: NarsilBackend
  state: AppState
  dispatch: Dispatch<AppAction>
}

function IndexButton({ name, active, dispatch }: { name: string; active: boolean; dispatch: Dispatch<AppAction> }) {
  const handleClick = useCallback(() => {
    dispatch({ type: 'SET_ACTIVE_INDEX', payload: name })
  }, [dispatch, name])

  return (
    <Button variant={active ? 'default' : 'outline'} size="xs" className="font-mono text-xs" onClick={handleClick}>
      {name}
    </Button>
  )
}

export function InspectorView({ backend, state, dispatch }: InspectorViewProps) {
  const indexName = state.activeIndexName
  const [stats, setStats] = useState<IndexStats | null>(null)
  const [partitionStats, setPartitionStats] = useState<PartitionStats[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<'stats' | 'schema' | 'vectors'>('stats')

  useEffect(() => {
    if (!indexName) {
      setStats(null)
      setPartitionStats([])
      return
    }

    setIsLoading(true)
    Promise.all([backend.getStats(indexName), backend.getPartitionStats(indexName)])
      .then(([s, ps]) => {
        setStats(s)
        setPartitionStats(ps)
      })
      .finally(() => setIsLoading(false))
  }, [backend, indexName])

  const handleStatsTab = useCallback(() => {
    setActiveTab('stats')
  }, [])

  const handleSchemaTab = useCallback(() => {
    setActiveTab('schema')
  }, [])

  const handleVectorsTab = useCallback(() => {
    setActiveTab('vectors')
  }, [])

  if (!indexName) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="mb-2 font-serif text-3xl tracking-tight">Index Inspector</h1>
        <p className="text-sm text-muted-foreground">
          Load a dataset from the Datasets tab to inspect index structure, memory stats, and vector space.
        </p>
      </div>
    )
  }

  const activeIndex = state.indexes.find(i => i.name === indexName)

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6">
        <h1 className="mb-1 font-serif text-3xl tracking-tight">Index Inspector</h1>
        {activeIndex && (
          <p className="text-sm text-muted-foreground">
            Inspecting <span className="font-mono font-medium text-foreground">{activeIndex.name}</span>
          </p>
        )}
      </div>

      {state.indexes.length > 1 && (
        <div className="mb-4 flex flex-wrap gap-1.5">
          {state.indexes.map(idx => (
            <IndexButton key={idx.name} name={idx.name} active={idx.name === indexName} dispatch={dispatch} />
          ))}
        </div>
      )}

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

      {isLoading && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Skeleton className="h-24 rounded-lg" />
          <Skeleton className="h-24 rounded-lg" />
          <Skeleton className="h-24 rounded-lg" />
          <Skeleton className="h-24 rounded-lg" />
        </div>
      )}

      {!isLoading && stats && activeTab === 'stats' && <StatsTab stats={stats} partitionStats={partitionStats} />}

      {!isLoading && stats && activeTab === 'schema' && <SchemaDisplay schema={stats.schema} />}

      {activeTab === 'vectors' && indexName && (
        <Suspense
          fallback={
            <div className="py-12 text-center text-sm text-muted-foreground">Loading vector visualization...</div>
          }
        >
          <VectorTab indexName={indexName} />
        </Suspense>
      )}
    </div>
  )
}
