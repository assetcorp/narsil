import { resolve } from 'node:path'
import { type CheckOutcome, checkRead, checkWritten } from './checks'
import { fetchPinnedDataset } from './dataset/fetch'

const USAGE = [
  'usage: narsil-conformance <command> [directory]',
  '',
  '  fetch                    download the pinned dataset and check every digest',
  "  check-read <directory>   compare <directory>/<kind>/<variant>.json with each sample file's expected JSON",
  '  check-written <directory> read <directory>/<kind>/<variant> through the reference and compare it with the JSON',
].join('\n')

function reported(outcomes: readonly CheckOutcome[]): number {
  const failed = outcomes.filter(outcome => outcome.problem !== null)
  for (const outcome of outcomes) {
    console.log(outcome.problem === null ? `pass  ${outcome.name}` : `FAIL  ${outcome.name}: ${outcome.problem}`)
  }
  console.log(`${outcomes.length - failed.length} of ${outcomes.length} samples pass`)
  return failed.length === 0 ? 0 : 1
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, directory] = argv
  if (command === 'fetch' && directory === undefined) {
    console.log(`the dataset is ready in ${await fetchPinnedDataset()}`)
    return 0
  }
  if (command === 'check-read' && directory !== undefined) return reported(await checkRead(resolve(directory)))
  if (command === 'check-written' && directory !== undefined) return reported(await checkWritten(resolve(directory)))
  console.error(USAGE)
  return 2
}

process.exitCode = await main(process.argv.slice(2))
