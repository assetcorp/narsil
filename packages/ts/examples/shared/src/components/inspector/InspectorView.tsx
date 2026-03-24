import { useState, useEffect, type Dispatch } from 'react'
import type { NarsilBackend, IndexStats, PartitionStats } from '../../backend'
import type { AppState, AppAction } from '../../types'
import { StatsTab } from './StatsTab'
import { SchemaDisplay } from './SchemaDisplay'
import { Button } from '../ui/button'

interface InspectorViewProps {
  backend: NarsilBackend
  state: AppState
  dispatch: Dispatch<AppAction>
}

export function InspectorView({ backend, state, dispatch }: InspectorViewProps) {
  const indexName = state.activeIndexName
  const [stats, setStats] = useState<IndexStats | null>(null)
  const [partitionStats, setPartitionStats] = useState<PartitionStats[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<'stats' | 'schema'>('stats')

  useEffect(() => {
    if (!indexName) {
      setStats(null)
      setPartitionStats([])
      return
    }

    setIsLoading(true)
    Promise.all([
      backend.getStats(indexName),
      backend.getPartitionStats(indexName),
    ])
      .then(([s, ps]) => {
        setStats(s)
        setPartitionStats(ps)
      })
      .finally(() => setIsLoading(false))
  }, [backend, indexName])

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

  const activeIndex = state.indexes.find((i) => i.name === indexName)

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
          {state.indexes.map((idx) => (
            <Button
              key={idx.name}
              variant={idx.name === indexName ? 'default' : 'outline'}
              size="xs"
              className="font-mono text-xs"
              onClick={() => dispatch({ type: 'SET_ACTIVE_INDEX', payload: idx.name })}
            >
              {idx.name}
            </Button>
          ))}
        </div>
      )}

      <div className="mb-4 flex gap-1">
        <Button
          variant={activeTab === 'stats' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setActiveTab('stats')}
        >
          Stats
        </Button>
        <Button
          variant={activeTab === 'schema' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setActiveTab('schema')}
        >
          Schema
        </Button>
      </div>

      {isLoading && (
        <div className="py-12 text-center text-sm text-muted-foreground">Loading stats...</div>
      )}

      {!isLoading && stats && activeTab === 'stats' && (
        <StatsTab stats={stats} partitionStats={partitionStats} />
      )}

      {!isLoading && stats && activeTab === 'schema' && (
        <SchemaDisplay schema={stats.schema} />
      )}
    </div>
  )
}
