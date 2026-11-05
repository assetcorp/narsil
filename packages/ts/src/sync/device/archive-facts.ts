import { decodeIndexConfiguration } from '../../engine/snapshot/index-configuration-decode'
import { ClientErrorCodes, NarsilError } from '../../errors'
import { createByteReader } from '../../persistence/archive/byte-reader'
import { readSnapshotArchive } from '../../persistence/archive/read'
import type { ByteSource } from '../../types/byte-source'
import { isSyncEpoch } from '../epoch'

export interface ArchiveAnalysis {
  language: string
  tokenizer?: string
  stopWords?: string
  analysisRevision?: string
}

export interface ArchiveFacts {
  epoch: string
  seqNos: number[]
  analysis: ArchiveAnalysis
}

class FactsComplete {}

function unusable(detail: string): NarsilError {
  return new NarsilError(ClientErrorCodes.CLIENT_INVALID_RESPONSE, `The sync snapshot is unusable: ${detail}`)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export async function readArchiveFacts(source: ByteSource): Promise<ArchiveFacts> {
  const reader = createByteReader(source)
  const read: { config: Record<string, unknown> | null; seqNos: number[] | null } = { config: null, seqNos: null }
  try {
    await readSnapshotArchive(reader, {
      async config(bytes) {
        read.config = { ...(await decodeIndexConfiguration(bytes)) }
      },
      async manifest(manifest) {
        const found = new Array<number>(manifest.checkpoint.length).fill(-1)
        for (const entry of manifest.checkpoint) {
          if (entry.partitionId >= found.length || found[entry.partitionId] !== -1) {
            throw unusable('its manifest names a partition twice or skips one')
          }
          found[entry.partitionId] = entry.lastSeqNo
        }
        read.seqNos = found
        throw new FactsComplete()
      },
      async file() {
        throw unusable('a file comes before its manifest')
      },
    })
  } catch (error) {
    if (!(error instanceof FactsComplete)) throw error
  } finally {
    await reader.close()
  }
  const { config, seqNos } = read
  if (config === null || seqNos === null) throw unusable('it holds no configuration or no manifest')
  if (!isSyncEpoch(config.syncEpoch)) throw unusable('its configuration holds no sync epoch')
  const language = optionalString(config.language)
  if (language === undefined) throw unusable('its configuration holds no language')
  const tokenizer = optionalString(config.tokenizer)
  const stopWords = optionalString(config.stopWords)
  const analysisRevision = optionalString(config.analysisRevision)
  return {
    epoch: config.syncEpoch,
    seqNos,
    analysis: {
      language,
      ...(tokenizer !== undefined ? { tokenizer } : {}),
      ...(stopWords !== undefined ? { stopWords } : {}),
      ...(analysisRevision !== undefined ? { analysisRevision } : {}),
    },
  }
}
