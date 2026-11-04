import { createNarsil } from '@delali/narsil-react-native'
import { File, Paths } from 'expo-file-system'
import { download, upload } from '../harness'
import {
  answersAfterRestore,
  fillSnapshotIndex,
  PHONE_SNAPSHOT,
  type RestoredReport,
  SERVER_SNAPSHOT,
  SNAPSHOT_INDEX,
} from './snapshot-answers'

const FILE_URI_PREFIX = 'file://'

function documentFile(name: string): { file: File; path: string } {
  const file = new File(Paths.document, name)
  const uri = file.uri
  const path = decodeURI(uri.startsWith(FILE_URI_PREFIX) ? uri.slice(FILE_URI_PREFIX.length) : uri)
  return { file, path }
}

function removeIfPresent(file: File): void {
  if (file.exists) file.delete()
}

export async function sendPhoneSnapshot(): Promise<{ bytes: number; documents: number }> {
  const narsil = await createNarsil({ durability: null })
  const { file, path } = documentFile(PHONE_SNAPSHOT)
  try {
    const documents = await fillSnapshotIndex(narsil)
    removeIfPresent(file)
    const written = await narsil.snapshotToFile(SNAPSHOT_INDEX, path)
    const bytes = await file.bytes()
    if (bytes.byteLength !== written) {
      throw new Error(`The snapshot file holds ${bytes.byteLength} bytes, but the engine wrote ${written}`)
    }
    await upload(PHONE_SNAPSHOT, bytes)
    return { bytes: written, documents }
  } finally {
    removeIfPresent(file)
    await narsil.shutdown()
  }
}

export async function restoreServerSnapshot(): Promise<RestoredReport> {
  const narsil = await createNarsil({ durability: null })
  const { file, path } = documentFile(SERVER_SNAPSHOT)
  try {
    const bytes = await download(SERVER_SNAPSHOT)
    removeIfPresent(file)
    await file.write(bytes)
    const started = performance.now()
    await narsil.restoreFromFile(SNAPSHOT_INDEX, path)
    return await answersAfterRestore(narsil, performance.now() - started)
  } finally {
    removeIfPresent(file)
    await narsil.shutdown()
  }
}
