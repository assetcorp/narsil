import { BEIR_DATASETS, type BeirDatasetName, loadBeirDataset } from './index'

function parseTargets(argv: string[]): BeirDatasetName[] {
  const requested = argv.slice(2).filter(arg => !arg.startsWith('-'))
  if (requested.length === 0) return [...BEIR_DATASETS]
  return requested.map(name => {
    if ((BEIR_DATASETS as readonly string[]).includes(name)) return name as BeirDatasetName
    throw new Error(`unknown BEIR dataset '${name}'; known datasets: ${BEIR_DATASETS.join(', ')}`)
  })
}

async function main(): Promise<void> {
  const targets = parseTargets(process.argv)
  const refresh = process.argv.includes('--refresh')
  console.log(`Regenerating BEIR pins: ${targets.join(', ')}`)
  for (const name of targets) {
    const dataset = await loadBeirDataset(name, { updatePin: true, refresh })
    console.log(
      `  ${name}: ${dataset.counts.documents} docs, ${dataset.counts.queries} queries, ` +
        `${dataset.counts.qrels} judgments, fingerprint ${dataset.corpusFingerprint.slice(0, 12)}…`,
    )
  }
  console.log('Done. Commit the updated manifests under src/data/beir/manifests/.')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
