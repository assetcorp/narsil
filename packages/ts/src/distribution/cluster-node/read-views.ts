import type { ClusterCoordinator } from '../coordinator/types'
import { type AnalysisView, createAnalysisView } from './analysis-change/view'
import { type Bm25View, createBm25View } from './bm25-view'
import type { ClusterLocalEngine } from './local-engine'
import type { ClusterReadDeps } from './reads'
import { createVectorReadView } from './reads/vector-reads'

export interface ReadViews {
  bm25View: Bm25View
  analysisView: AnalysisView
  readDeps: ClusterReadDeps
  start(): Promise<void>
  stop(): void
}

export function createReadViews(
  base: Omit<ClusterReadDeps, 'bm25View' | 'analysisView' | 'vectorReads'>,
  coordinator: ClusterCoordinator,
  engine: ClusterLocalEngine,
  onError: (error: unknown) => void,
): ReadViews {
  const bm25View = createBm25View({ coordinator, engine, onError })
  const analysisView = createAnalysisView({ coordinator, engine, onError })
  const vectorReads = createVectorReadView({ coordinator, onError })
  return {
    bm25View,
    analysisView,
    readDeps: { ...base, bm25View, analysisView, vectorReads },
    async start() {
      await bm25View.start()
      await analysisView.start()
      await vectorReads.start()
    },
    stop() {
      bm25View.stop()
      analysisView.stop()
      vectorReads.stop()
    },
  }
}
