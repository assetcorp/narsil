import { writeFile } from 'node:fs/promises'
import { fetchPinnedDataset } from '../dataset/fetch'
import { loadDataset } from '../dataset/load'
import { readPin } from '../dataset/pin'
import { computeExpectedSearches, SEARCHES_PATH } from './expected'
import { openReferenceIndex } from './reference-index'

const ENTRY_ACROSS_LINES = /\{\n\s+"id": ("[^"\n]*"),\n\s+"(score|similarity)": ([^\n,]+)\n\s+\}/g

const pin = await readPin()
if (pin === null) throw new Error('the suite pins no dataset, so it has nothing to search')
const dataset = await loadDataset(await fetchPinnedDataset())
const reference = await openReferenceIndex(dataset)
try {
  const expected = await computeExpectedSearches(pin, dataset, reference)
  const text = JSON.stringify(expected, null, 1).replace(ENTRY_ACROSS_LINES, '{"id": $1, "$2": $3}')
  await writeFile(SEARCHES_PATH, `${text}\n`)
  console.log(`wrote ${SEARCHES_PATH}`)
} finally {
  await reference.shutdown()
}
