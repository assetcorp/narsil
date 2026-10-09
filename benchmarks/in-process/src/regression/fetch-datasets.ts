import { assertDatasetName, ensureBeirArchives } from '../data/beir'
import { PERF_DATASET } from '../perf-corpus'
import { RANKING_QUALITY } from './ranking-quality'

await ensureBeirArchives([PERF_DATASET, ...RANKING_QUALITY.subjects.map(assertDatasetName)])
