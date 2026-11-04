import type { PhoneNarsil } from '@delali/narsil-react-native/worklets'
import { download, upload } from '../../expo/src/harness'
import {
  answersAfterRestore,
  fillSnapshotIndex,
  PHONE_SNAPSHOT,
  type RestoredReport,
  SERVER_SNAPSHOT,
  SNAPSHOT_INDEX,
} from '../../expo/src/tasks/snapshot-answers'

export type OpenInMemory = () => Promise<PhoneNarsil>

export async function sendPhoneSnapshotFromMemory(open: OpenInMemory): Promise<{ bytes: number; documents: number }> {
  const narsil = await open()
  try {
    const documents = await fillSnapshotIndex(narsil)
    const bytes = await narsil.snapshot(SNAPSHOT_INDEX)
    await upload(PHONE_SNAPSHOT, bytes)
    return { bytes: bytes.byteLength, documents }
  } finally {
    await narsil.shutdown()
  }
}

export async function restoreServerSnapshotFromMemory(open: OpenInMemory): Promise<RestoredReport> {
  const narsil = await open()
  try {
    const bytes = await download(SERVER_SNAPSHOT)
    const started = performance.now()
    await narsil.restore(SNAPSHOT_INDEX, bytes)
    return await answersAfterRestore(narsil, performance.now() - started)
  } finally {
    await narsil.shutdown()
  }
}
