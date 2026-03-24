const RELEASE_BASE = 'https://github.com/assetcorp/narsil/releases/download/data-v0'

export type DatasetId = 'tmdb' | 'wikipedia' | 'cranfield' | 'custom'

export interface DatasetTier {
  label: string
  file: string
  url: string | null
  sizeBytes: number
  docCount: number
}

export interface WikiLanguage {
  code: string
  name: string
  file: string
  url: string | null
  sizeBytes: number
  docCount: number
}

export interface TmdbDataset {
  id: 'tmdb'
  name: string
  tiers: DatasetTier[]
  vectorFile: {
    file: string
    url: string
    sizeBytes: number
    dims: number
    docCount: number
  } | null
}

export interface WikipediaDataset {
  id: 'wikipedia'
  name: string
  languages: WikiLanguage[]
}

export interface CranfieldDataset {
  id: 'cranfield'
  name: string
  docsFile: string
  queriesFile: string
  qrelsFile: string
  docCount: number
  queryCount: number
}

export interface CustomDataset {
  id: 'custom'
  name: string
}

export type Dataset = TmdbDataset | WikipediaDataset | CranfieldDataset | CustomDataset

export const COMMITTED_SIZE_THRESHOLD = 10 * 1024 * 1024

export const tmdb: TmdbDataset = {
  id: 'tmdb',
  name: 'TMDB Movies',
  tiers: [
    { label: '1k', file: 'movies-1000.json', url: null, sizeBytes: 602_000, docCount: 1_000 },
    { label: '5k', file: 'movies-5000.json', url: null, sizeBytes: 2_950_000, docCount: 5_000 },
    { label: '10k', file: 'movies-10000.json', url: null, sizeBytes: 5_800_000, docCount: 10_000 },
    { label: '50k', file: 'movies-50000.json', url: `${RELEASE_BASE}/movies-50000.json`, sizeBytes: 29_574_832, docCount: 50_000 },
    { label: '100k', file: 'movies-100000.json', url: `${RELEASE_BASE}/movies-100000.json`, sizeBytes: 58_915_806, docCount: 100_000 },
  ],
  vectorFile: {
    file: 'movies-10000-vectors-1536.bin',
    url: `${RELEASE_BASE}/movies-10000-vectors-1536.bin`,
    sizeBytes: 61_440_008,
    dims: 1536,
    docCount: 10_000,
  },
}

export const wikipedia: WikipediaDataset = {
  id: 'wikipedia',
  name: 'Multilingual Wikipedia',
  languages: [
    { code: 'ee', name: 'Ewe', file: 'wikipedia-ee.json', url: null, sizeBytes: 856_000, docCount: 958 },
    { code: 'zu', name: 'Zulu', file: 'wikipedia-zu.json', url: null, sizeBytes: 6_553_600, docCount: 3_286 },
    { code: 'tw', name: 'Twi', file: 'wikipedia-tw.json', url: null, sizeBytes: 7_782_400, docCount: 2_814 },
    { code: 'yo', name: 'Yoruba', file: 'wikipedia-yo.json', url: `${RELEASE_BASE}/wikipedia-yo.json`, sizeBytes: 12_468_067, docCount: 6_109 },
    { code: 'sw', name: 'Swahili', file: 'wikipedia-sw.json', url: `${RELEASE_BASE}/wikipedia-sw.json`, sizeBytes: 13_876_395, docCount: 8_432 },
    { code: 'ha', name: 'Hausa', file: 'wikipedia-ha.json', url: `${RELEASE_BASE}/wikipedia-ha.json`, sizeBytes: 20_298_419, docCount: 10_124 },
    { code: 'dag', name: 'Dagbani', file: 'wikipedia-dag.json', url: `${RELEASE_BASE}/wikipedia-dag.json`, sizeBytes: 22_011_752, docCount: 6_780 },
    { code: 'ig', name: 'Igbo', file: 'wikipedia-ig.json', url: `${RELEASE_BASE}/wikipedia-ig.json`, sizeBytes: 28_196_013, docCount: 11_234 },
    { code: 'en', name: 'English', file: 'wikipedia-en.json', url: `${RELEASE_BASE}/wikipedia-en.json`, sizeBytes: 94_218_652, docCount: 25_000 },
    { code: 'fr', name: 'French', file: 'wikipedia-fr.json', url: `${RELEASE_BASE}/wikipedia-fr.json`, sizeBytes: 167_726_466, docCount: 25_000 },
  ],
}

export const cranfield: CranfieldDataset = {
  id: 'cranfield',
  name: 'Cranfield Collection',
  docsFile: 'cranfield-docs.json',
  queriesFile: 'cranfield-queries.json',
  qrelsFile: 'cranfield-qrels.json',
  docCount: 1400,
  queryCount: 225,
}

export const custom: CustomDataset = {
  id: 'custom',
  name: 'Your Dataset',
}

export const datasets: Dataset[] = [tmdb, wikipedia, cranfield, custom]
