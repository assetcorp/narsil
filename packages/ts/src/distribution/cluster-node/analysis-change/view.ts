import { ErrorCodes, NarsilError } from '../../../errors'
import type { NamedAnalysisSettings } from '../../../types/internal'
import {
  type IndexMetadataSnapshot,
  indexMetadataSnapshotOf,
  readIndexMetadataSnapshot,
} from '../../cluster/index-metadata'
import type { IndexSettings } from '../../cluster/index-settings'
import type { ClusterCoordinator } from '../../coordinator/types'
import type { ClusterLocalEngine } from '../local-engine'

export interface AnalysisView {
  held(indexName: string): number | undefined
  generationFor(indexName: string): Promise<number>
  refresh(indexName: string): Promise<number>
  answerAt<T>(indexName: string, requested: number, read: () => Promise<T>): Promise<T>
  settle(indexName: string): Promise<void>
  start(): Promise<void>
  stop(): void
}

interface AnalysisViewDeps {
  coordinator: ClusterCoordinator
  engine: ClusterLocalEngine
  onError(error: unknown): void
}

export function namedSettingsOfMetadata(settings: IndexSettings | undefined): NamedAnalysisSettings {
  return {
    language: settings?.language ?? 'english',
    ...(settings?.tokenizer !== undefined ? { tokenizer: settings.tokenizer } : {}),
    ...(settings?.stopWords !== undefined ? { stopWords: settings.stopWords } : {}),
    ...(settings?.stopWordList !== undefined ? { stopWordList: settings.stopWordList } : {}),
  }
}

function generationMissing(indexName: string, requestedGeneration: number, heldGeneration: number): NarsilError {
  return new NarsilError(
    ErrorCodes.ANALYSIS_GENERATION_MISSING,
    `This node holds analysis generation ${heldGeneration} of index '${indexName}', so it cannot answer for generation ${requestedGeneration}`,
    { indexName, requestedGeneration, heldGeneration },
  )
}

export function createAnalysisView(deps: AnalysisViewDeps): AnalysisView {
  const { coordinator, engine, onError } = deps
  const held = new Map<string, { indexUuid: string; generation: number }>()
  const settling = new Map<string, Promise<void>>()
  let unwatch: (() => void) | null = null
  let stopped = false

  function recordGeneration(indexName: string, snapshot: IndexMetadataSnapshot): number {
    const generation = snapshot.settings?.analysisGeneration ?? 0
    const { indexUuid } = snapshot.record
    const known = held.get(indexName)
    if (known?.indexUuid === indexUuid && known.generation >= generation) return known.generation
    held.set(indexName, { indexUuid, generation })
    return generation
  }

  async function refresh(indexName: string): Promise<number> {
    const snapshot = await readIndexMetadataSnapshot(coordinator, indexName)
    if (snapshot === null) {
      held.delete(indexName)
      return 0
    }
    return recordGeneration(indexName, snapshot)
  }

  function catchUp(indexName: string, generation: number, settings: IndexSettings | undefined): void {
    engine
      .buildHeldAnalysis(indexName, { generation, ...namedSettingsOfMetadata(settings) })
      .then(() => engine.releaseHeldAnalysis(indexName, generation))
      .catch((error: unknown) => {
        if (!stopped) onError(error)
      })
  }

  async function settleOnce(indexName: string): Promise<void> {
    const generation = engine.analysisGenerationOf(indexName)
    if (stopped || generation === undefined) return
    const snapshot = await readIndexMetadataSnapshot(coordinator, indexName)
    const localUuid = engine.indexUuidOf(indexName)
    if (snapshot === null || (typeof localUuid === 'string' && localUuid !== snapshot.record.indexUuid)) return
    recordGeneration(indexName, snapshot)
    const { settings } = snapshot
    const published = settings?.analysisGeneration ?? 0
    const localPending = engine.pendingAnalysisGenerationOf(indexName)
    if (published > generation) {
      if (localPending !== published && engine.holdsAnalysisSettings(indexName, namedSettingsOfMetadata(settings))) {
        if (localPending !== null) await engine.dropHeldAnalysis(indexName)
        await engine.stampAnalysisGeneration(indexName, published)
        return
      }
      catchUp(indexName, published, settings)
      return
    }
    if (localPending !== null && localPending > published && settings?.pendingAnalysis?.generation !== localPending) {
      await engine.dropHeldAnalysis(indexName)
    }
  }

  function settle(indexName: string): Promise<void> {
    const next = (settling.get(indexName) ?? Promise.resolve()).then(() => settleOnce(indexName)).catch(onError)
    settling.set(indexName, next)
    return next
  }

  async function reach(indexName: string, requested: number): Promise<void> {
    if (engine.heldAnalysisIsBuilt(indexName, requested)) {
      await engine.releaseHeldAnalysis(indexName, requested).catch(onError)
      return
    }
    await settle(indexName)
  }

  async function reachThenRead(indexName: string, requested: number, generation: number): Promise<void> {
    if (generation < requested) await reach(indexName, requested)
    const reached = engine.analysisGenerationOf(indexName) ?? generation
    if (reached !== requested) throw generationMissing(indexName, requested, reached)
  }

  return {
    held(indexName) {
      return held.get(indexName)?.generation
    },
    async generationFor(indexName) {
      return held.get(indexName)?.generation ?? refresh(indexName)
    },
    refresh,
    answerAt(indexName, requested, read) {
      const generation = engine.analysisGenerationOf(indexName)
      if (generation === undefined) return read()
      const readAtRequested = <T>(answerOf: () => Promise<T>): Promise<T> =>
        answerOf().then(answer => {
          const after = engine.analysisGenerationOf(indexName) ?? requested
          if (after !== requested) throw generationMissing(indexName, requested, after)
          return answer
        })
      if (generation === requested) return readAtRequested(read)
      return reachThenRead(indexName, requested, generation).then(() => readAtRequested(read))
    },
    settle,
    async start() {
      if (unwatch !== null) return
      stopped = false
      unwatch = await coordinator.watchIndexMetadata(event => {
        if (event.metadata === null) {
          held.delete(event.indexName)
          return
        }
        try {
          recordGeneration(event.indexName, indexMetadataSnapshotOf(event.metadata, event.indexName))
        } catch (error) {
          onError(error)
        }
        void settle(event.indexName)
      })
    },
    stop() {
      stopped = true
      unwatch?.()
      unwatch = null
      held.clear()
    },
  }
}
