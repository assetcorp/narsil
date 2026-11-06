import { encode } from '@msgpack/msgpack'
import {
  decodeIndexConfiguration,
  INDEX_CONFIGURATION_ENVELOPE_VERSION,
} from '../../engine/snapshot/index-configuration-decode'
import type { RestoredHistorySink } from '../../engine/snapshot/restore-setup'
import { joinChunks } from '../../persistence/object-store'
import { packChecksummedEnvelope } from '../../serialization/envelope-file'
import type { StoredQuerySuggestions } from '../../types/internal'
import { assertStillDriving, type BackupDriverContext } from './driver-context'
import { loadCheckedBytes, loadCheckedFile, saveSmallFile, storedDigests } from './files'
import type { BackupManifest, StoredFile } from './manifest'

export interface RestoredHistoryWriter extends RestoredHistorySink {
  commit(): Promise<void>
}

export interface ClusterQueryHistory {
  eachFile(indexName: string, visit: (bytes: Uint8Array) => Promise<void>): Promise<void>
  clearName(indexName: string): Promise<void>
  restoredSink(indexName: string): Promise<RestoredHistoryWriter | null>
  afterRestore(indexName: string): Promise<void>
}

export async function configWithSuggestionState(
  context: BackupDriverContext,
  config: StoredFile,
  state: StoredQuerySuggestions | null,
): Promise<StoredFile> {
  if (state === null) return config
  const { store, job } = context
  const envelope = await decodeIndexConfiguration(await loadCheckedBytes(store, config, job.backupName))
  const packed = await packChecksummedEnvelope(
    [encode({ ...envelope, ...state }, { ignoreUndefined: true })],
    INDEX_CONFIGURATION_ENVELOPE_VERSION,
    'index configuration',
  )
  return saveSmallFile(store, joinChunks(packed.chunks, packed.byteLength), await storedDigests(store))
}

export async function backUpQueryHistory(context: BackupDriverContext, indexName: string): Promise<StoredFile[]> {
  const { queryHistory } = context
  if (queryHistory === null) return []
  const held = await storedDigests(context.store)
  const stored: StoredFile[] = []
  await queryHistory.eachFile(indexName, async bytes => {
    assertStillDriving(context)
    stored.push(await saveSmallFile(context.store, bytes, held))
  })
  return stored
}

export async function checkRestoredHistory(context: BackupDriverContext, manifest: BackupManifest): Promise<void> {
  for (const file of manifest.queryHistory ?? []) {
    assertStillDriving(context)
    await loadCheckedFile(context.store, file, manifest.name, async () => undefined)
  }
}

async function* onlyChunk(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes
}

export async function writeRestoredHistory(
  context: BackupDriverContext,
  manifest: BackupManifest,
  indexName: string,
): Promise<void> {
  const { queryHistory } = context
  if (queryHistory === null) return
  await queryHistory.afterRestore(indexName)
  const files = manifest.queryHistory ?? []
  const sink = files.length === 0 ? null : await queryHistory.restoredSink(indexName)
  if (sink === null) return
  try {
    for (const file of files) {
      assertStillDriving(context)
      await sink.add(onlyChunk(await loadCheckedBytes(context.store, file, manifest.name)))
    }
    await sink.commit()
  } catch (error) {
    await sink.abandon().catch(context.onError)
    throw error
  }
}
