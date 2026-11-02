import { File, Paths } from 'expo-file-system'

const COPIED_HARNESS_URL_FILE = 'narsil-harness-url.txt'

export function readCopiedHarnessUrl(): string | null {
  const file = new File(Paths.document, COPIED_HARNESS_URL_FILE)
  const url = file.exists ? file.textSync().trim() : ''
  return url.length > 0 ? url : null
}
