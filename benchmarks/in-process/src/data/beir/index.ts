import type { BenchDocument } from '../../types'
import { extractEntries, fetchArchive } from './archive'
import { corpusFingerprint, indexableDocs, sha256Hex } from './fingerprint'
import { assertManifestMatches, readManifest, writeManifest } from './manifest'
import { countJudgments, filterQueriesToQrels, parseCorpus, parseQrels, parseQueries } from './parse'
import { assertDatasetName, DOCUMENT_TEXT_RULE, FINGERPRINT_ALGORITHM, REGISTRY } from './registry'
import type { BeirDataset, BeirDatasetName, BeirManifest, LoadBeirOptions, RawCorpusDoc } from './types'

export { corpusFingerprint, documentText } from './fingerprint'
export { assertDatasetName } from './registry'
export type { BeirDataset, BeirDatasetName, BeirManifest, BeirQuery, Qrels } from './types'
export { BEIR_DATASETS } from './types'

function toBenchDocuments(docs: RawCorpusDoc[], name: BeirDatasetName): BenchDocument[] {
  return docs.map(doc => ({
    id: doc.id,
    title: doc.title,
    body: doc.text,
    score: 0,
    category: name,
  }))
}

export async function loadBeirDataset(rawName: string, options: LoadBeirOptions = {}): Promise<BeirDataset> {
  const name = assertDatasetName(rawName)
  const zip = await fetchArchive(name, options)
  const archiveSha256 = sha256Hex(zip)

  const entries = extractEntries(zip, name)
  const corpus = indexableDocs(parseCorpus(entries.corpus))
  const qrels = parseQrels(entries.qrelsTest)
  const queries = filterQueriesToQrels(parseQueries(entries.queries), qrels)

  const fingerprint = corpusFingerprint(corpus)
  const counts = {
    documents: corpus.length,
    queries: queries.length,
    qrels: countJudgments(qrels),
  }

  const manifest: BeirManifest = {
    name,
    source: REGISTRY[name].url,
    license: REGISTRY[name].license,
    archiveBytes: zip.length,
    archiveSha256,
    counts,
    corpusFingerprint: fingerprint,
    documentTextRule: DOCUMENT_TEXT_RULE,
    fingerprintAlgorithm: FINGERPRINT_ALGORITHM,
  }

  if (options.updatePin) {
    writeManifest(manifest)
    console.log(`  wrote BEIR pin for ${name}`)
  } else {
    const pinned = readManifest(name)
    if (pinned === null) {
      throw new Error(`no committed pin for BEIR dataset '${name}'; generate it once with BENCH_UPDATE_BEIR_PINS=1`)
    }
    assertManifestMatches(pinned, manifest)
  }

  return {
    name,
    documents: toBenchDocuments(corpus, name),
    queries,
    qrels,
    counts,
    archiveSha256,
    corpusFingerprint: fingerprint,
  }
}
