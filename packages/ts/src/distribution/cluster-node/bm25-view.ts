import { decode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../errors'
import type { BM25Params } from '../../types/schema'
import { readIndexMetadataSnapshot } from '../cluster/index-metadata'
import { decodeIndexSettings, isRecord } from '../cluster/index-settings'
import type { ClusterCoordinator } from '../coordinator/types'
import type { ClusterLocalEngine } from './local-engine'

export interface HeldBm25Setting {
  indexUuid: string
  bm25: BM25Params | undefined
  revision: number | undefined
}

export interface Bm25View {
  current(indexName: string): Promise<HeldBm25Setting | null>
  start(): Promise<void>
  stop(): void
  applyWritten(indexName: string, written: HeldBm25Setting): Promise<void>
  applyToLocalCopy(indexName: string, indexUuid: string): Promise<void>
}

interface Bm25ViewDeps {
  coordinator: ClusterCoordinator
  engine: Pick<ClusterLocalEngine, 'indexUuidOf' | 'applyStoredBm25'>
  onError(error: unknown): void
}

function settingOfMetadata(bytes: Uint8Array, indexName: string): HeldBm25Setting | null {
  const decoded: unknown = decode(bytes)
  if (!isRecord(decoded) || typeof decoded.indexUuid !== 'string') return null
  const settings = decodeIndexSettings(decoded.settings, indexName)
  return { indexUuid: decoded.indexUuid, bm25: settings?.bm25, revision: settings?.bm25Revision }
}

function isLaterThan(next: HeldBm25Setting, held: HeldBm25Setting): boolean {
  return (next.revision ?? 0) > (held.revision ?? 0)
}

export function createBm25View(deps: Bm25ViewDeps): Bm25View {
  const { coordinator, engine, onError } = deps
  const held = new Map<string, HeldBm25Setting>()
  let unwatch: (() => void) | null = null

  function applyToLocalCopy(indexName: string, indexUuid: string): Promise<void> {
    if (engine.indexUuidOf(indexName) !== indexUuid) return Promise.resolve()
    return engine
      .applyStoredBm25(indexName, () => {
        const latest = held.get(indexName)
        if (latest === undefined || latest.indexUuid !== indexUuid) return null
        return engine.indexUuidOf(indexName) === indexUuid ? { bm25: latest.bm25 } : null
      })
      .then(
        () => undefined,
        (error: unknown) => {
          if (error instanceof NarsilError && error.code === ErrorCodes.INDEX_NOT_FOUND) return
          onError(error)
        },
      )
  }

  function hold(indexName: string, next: HeldBm25Setting): boolean {
    const current = held.get(indexName)
    if (current !== undefined && current.indexUuid === next.indexUuid && !isLaterThan(next, current)) return false
    held.set(indexName, next)
    return true
  }

  function receive(indexName: string, metadata: Uint8Array | null): void {
    if (metadata === null) {
      held.delete(indexName)
      return
    }
    let next: HeldBm25Setting | null
    try {
      next = settingOfMetadata(metadata, indexName)
    } catch (error) {
      onError(error)
      return
    }
    if (next !== null && hold(indexName, next)) void applyToLocalCopy(indexName, next.indexUuid)
  }

  return {
    async current(indexName) {
      const known = held.get(indexName)
      if (known !== undefined) return known
      const snapshot = await readIndexMetadataSnapshot(coordinator, indexName)
      if (snapshot === null) return null
      const read: HeldBm25Setting = {
        indexUuid: snapshot.record.indexUuid,
        bm25: snapshot.settings?.bm25,
        revision: snapshot.settings?.bm25Revision,
      }
      const racing = held.get(indexName)
      if (racing === undefined || (racing.indexUuid === read.indexUuid && isLaterThan(read, racing))) {
        held.set(indexName, read)
        return read
      }
      return racing
    },
    async start() {
      if (unwatch !== null) return
      unwatch = await coordinator.watchIndexMetadata(event => receive(event.indexName, event.metadata))
    },
    stop() {
      unwatch?.()
      unwatch = null
      held.clear()
    },
    async applyWritten(indexName, written) {
      hold(indexName, written)
      await applyToLocalCopy(indexName, written.indexUuid)
    },
    applyToLocalCopy,
  }
}
