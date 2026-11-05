import { type CaseBuild, damagedCheckpoint } from './build'
import { baseFile, listAt, mapAt, openRaw, type RawMap, rewritten } from './bytes'

const INDEX = 'products'
const LOAD_FAILED = 'PERSISTENCE_LOAD_FAILED'
const CONFIG_INVALID = 'CONFIG_INVALID'
const VERSION_MISMATCH = 'ENVELOPE_VERSION_MISMATCH'
const MANIFEST_RULE = 'durability.md#manifest'
const METADATA_RULE = 'envelope.md#index-metadata-payload'
const OLDER_THAN_EARLIER_LAYOUT = 5
const NEWER_THAN_CURRENT_LAYOUT = 8
const GENERATION_NO_SETTINGS_RECORD = 7
const K1_ABOVE_ITS_RANGE = 2_000

function firstCheckpoint(manifest: RawMap): RawMap {
  return mapAt(listAt(manifest.checkpoint, 'checkpoint')[0], 'checkpoint[0]')
}

async function manifestCase(name: string, rule: string, code: string, change: (manifest: RawMap) => void) {
  const manifest = await rewritten(await baseFile(INDEX, 'manifest'), name, change)
  return damagedCheckpoint(name, rule, code, INDEX, { manifest })
}

async function metadataCase(name: string, code: string | null, change: (metadata: RawMap) => void) {
  const meta = await rewritten(await baseFile(INDEX, 'meta'), name, change)
  return damagedCheckpoint(name, METADATA_RULE, code, INDEX, { meta })
}

function termHistoryCase(name: string, termHistory: { primaryTerm: number; firstSeqNo: number }[]) {
  return manifestCase(name, MANIFEST_RULE, LOAD_FAILED, manifest => {
    firstCheckpoint(manifest).termHistory = termHistory
  })
}

function vectorPromotion(metadata: RawMap): RawMap {
  return mapAt(metadata.vector_promotion, 'vector_promotion')
}

export async function manifestAndMetadataCases(): Promise<CaseBuild[]> {
  const manifest = await openRaw(await baseFile(INDEX, 'manifest'), `${INDEX} manifest`)
  const lastSeqNo = Number(firstCheckpoint(manifest.payload).lastSeqNo)
  const largeK1 = await metadataCase('metadata-k1-above-its-range', null, metadata => {
    mapAt(metadata.bm25_params, 'bm25_params').k1 = K1_ABOVE_ITS_RANGE
  })
  largeK1.search = 'trowel'
  return [
    await manifestCase('manifest-version-older', 'durability.md#earlier-layouts', VERSION_MISMATCH, manifest => {
      manifest.version = OLDER_THAN_EARLIER_LAYOUT
    }),
    await manifestCase('manifest-version-newer', MANIFEST_RULE, VERSION_MISMATCH, manifest => {
      manifest.version = NEWER_THAN_CURRENT_LAYOUT
    }),
    await termHistoryCase('term-history-terms-descend', [
      { primaryTerm: 2, firstSeqNo: 1 },
      { primaryTerm: 1, firstSeqNo: 10 },
    ]),
    await termHistoryCase('term-history-first-seq-nos-descend', [
      { primaryTerm: 1, firstSeqNo: 10 },
      { primaryTerm: 2, firstSeqNo: 5 },
    ]),
    await termHistoryCase('term-history-first-seq-no-above-last', [{ primaryTerm: 1, firstSeqNo: lastSeqNo + 1 }]),
    await manifestCase('analysis-generation-unknown', 'durability.md#index-metadata', CONFIG_INVALID, manifest => {
      manifest.analysisGeneration = GENERATION_NO_SETTINGS_RECORD
    }),
    await metadataCase('metadata-quantization-outside-its-set', CONFIG_INVALID, metadata => {
      vectorPromotion(metadata).quantization = 'osq3'
    }),
    await metadataCase('metadata-storage-outside-its-set', CONFIG_INVALID, metadata => {
      vectorPromotion(metadata).storage = 'tape'
    }),
    await metadataCase('metadata-text-storage-outside-its-set', CONFIG_INVALID, metadata => {
      metadata.text_storage = 'tape'
    }),
    await metadataCase('metadata-synonym-rule-shape', CONFIG_INVALID, metadata => {
      metadata.synonyms = [{ word: 'kettle', synonyms: [] }]
    }),
    await metadataCase('metadata-tokenizer-unregistered', CONFIG_INVALID, metadata => {
      metadata.tokenizer = 'conformance-unregistered-tokenizer'
    }),
    largeK1,
  ]
}
