import { createNarsilFullSchemaAdapter } from '../adapters/narsil'
import { assertDatasetName, loadBeirDataset } from '../data/beir'
import { scoreRelevance } from '../quality'
import type { QualityCheckDefinition } from './quality-check'

export const RANKING_QUALITY: QualityCheckDefinition = {
  check: 'ranking-quality',
  title: 'Ranking quality',
  subjects: ['scifact', 'nfcorpus'],
  metrics: [
    { key: 'meanNdcg10', label: 'nDCG@10' },
    { key: 'meanPrecision10', label: 'P@10' },
    { key: 'meanMap', label: 'MAP' },
    { key: 'meanMrr', label: 'MRR' },
  ],
}

export async function measureRankingQuality(subject: string): Promise<Record<string, number>> {
  const data = await loadBeirDataset(assertDatasetName(subject), {})
  const result = await scoreRelevance(createNarsilFullSchemaAdapter(), data)
  console.log(`${result.dataset}: ${result.docCount} documents, ${result.queryCount} judged queries`)
  return {
    meanNdcg10: result.meanNdcg10,
    meanPrecision10: result.meanPrecision10,
    meanMap: result.meanMap,
    meanMrr: result.meanMrr,
  }
}
