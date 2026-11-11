import { hasStopWords, hasTokenizer } from '../../analysis/registry'
import { ClientErrorCodes, NarsilError } from '../../errors'
import { getLanguage, hasLanguage } from '../../languages/registry'
import type { ArchiveAnalysis } from './archive-facts'

export function requireAnalysisOnDevice(indexName: string, analysis: ArchiveAnalysis): void {
  const missing: string[] = []
  if (!hasLanguage(analysis.language)) missing.push(`language "${analysis.language}"`)
  if (analysis.tokenizer !== undefined && !hasTokenizer(analysis.tokenizer)) {
    missing.push(`tokenizer "${analysis.tokenizer}"`)
  }
  if (analysis.stopWords !== undefined && !hasStopWords(analysis.stopWords)) {
    missing.push(`stop words "${analysis.stopWords}"`)
  }
  if (missing.length === 0) return
  throw new NarsilError(
    ClientErrorCodes.SYNC_ANALYSIS_UNAVAILABLE,
    `Index "${indexName}" on the server analyses text with ${missing.join(', ')}, which this device has not registered, so the device keeps its copy. Register them and sync again`,
    { indexName, missing },
  )
}

export function analysisIsStale(analysis: ArchiveAnalysis): boolean {
  if (analysis.analysisRevision === undefined || !hasLanguage(analysis.language)) return false
  return getLanguage(analysis.language).revision !== analysis.analysisRevision
}
