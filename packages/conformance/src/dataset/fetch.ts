import { fetchArtifact } from './artifact'
import { cacheDirectory, PIN_PATH, readPin } from './pin'

export async function fetchPinnedDataset(): Promise<string> {
  const pin = await readPin()
  if (pin === null) throw new Error(`${PIN_PATH} is missing, so the suite has no published dataset to fetch`)
  const directory = cacheDirectory()
  await fetchArtifact(pin, directory)
  return directory
}
