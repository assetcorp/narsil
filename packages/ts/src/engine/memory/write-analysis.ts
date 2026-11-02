import { resolveIndexAnalysis } from '../../analysis/registry'
import { getLanguage } from '../../languages/registry'
import type { EngineCore } from '../core'
import type { IndexWriteAnalysis } from './document-bound'

export type WriteAnalysisSource = Pick<EngineCore, 'indexRegistry' | 'executor'>

export function writeAnalysisOf(core: WriteAnalysisSource, indexName: string): IndexWriteAnalysis | null {
  const entry = core.indexRegistry.get(indexName)
  if (entry === undefined) return null
  const manager = core.executor.getManager(indexName)
  const language = manager?.language ?? getLanguage(entry.config.language ?? 'english')
  const customTokenizer = (manager?.analysis ?? resolveIndexAnalysis(entry.config)).customTokenizer
  return {
    schema: entry.config.schema,
    language,
    ...(customTokenizer === undefined ? {} : { customTokenizer }),
  }
}

export function vectorGrowthBytesOf(core: Pick<EngineCore, 'executor'>, indexName: string, documents: number): number {
  const manager = core.executor.getManager(indexName)
  if (manager === undefined || manager === null) return 0
  let bytes = 0
  for (const vectorIndex of manager.getVectorIndexes().values()) bytes += vectorIndex.growthBytesFor(documents)
  return bytes
}
