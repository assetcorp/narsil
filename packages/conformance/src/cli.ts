import { fetchPinnedDataset } from './dataset/fetch'

const USAGE = [
  'usage: narsil-conformance <command>',
  '',
  '  fetch   download the pinned dataset and check every digest',
].join('\n')

async function main(argv: readonly string[]): Promise<number> {
  const [command] = argv
  if (command === 'fetch') {
    console.log(`the dataset is ready in ${await fetchPinnedDataset()}`)
    return 0
  }
  console.error(USAGE)
  return 2
}

process.exitCode = await main(process.argv.slice(2))
