import { projectionKeepsField, type ResolvedProjection, type VectorReadSettings } from '../../../core/projection'
import { vectorFieldSegmentsOf } from '../../../schema/validator/schema'
import { decode } from '../../../serialization/msgpack'
import type { SchemaDefinition } from '../../../types/schema'
import { readIndexMetadataSnapshot } from '../../cluster/index-metadata'
import { decodeIndexSettings, isRecord } from '../../cluster/index-settings'
import type { AllocationTable, ClusterCoordinator } from '../../coordinator/types'

export interface VectorReadView {
  settingsOf(indexName: string, allocation: AllocationTable): Promise<VectorReadSettings>
  start(): Promise<void>
  stop(): void
}

interface HeldReturnVectors {
  indexUuid: string
  returnVectors: boolean
}

interface HeldVectorSettings {
  indexUuid: string
  settings: VectorReadSettings
}

interface VectorReadViewDeps {
  coordinator: ClusterCoordinator
  onError(error: unknown): void
}

const NO_KNOWN_VECTOR_FIELDS: VectorReadSettings = Object.freeze({ schema: Object.freeze({}) })

function returnVectorsOfMetadata(bytes: Uint8Array, indexName: string): HeldReturnVectors | null {
  const decoded: unknown = decode(bytes)
  if (!isRecord(decoded) || typeof decoded.indexUuid !== 'string') return null
  const settings = decodeIndexSettings(decoded.settings, indexName)
  return { indexUuid: decoded.indexUuid, returnVectors: settings?.returnVectors === true }
}

function servesAllocation(held: HeldVectorSettings, allocation: AllocationTable): boolean {
  return allocation.indexUuid === undefined || held.indexUuid === allocation.indexUuid
}

export function createVectorReadView(deps: VectorReadViewDeps): VectorReadView {
  const { coordinator, onError } = deps
  const schemas = new Map<string, SchemaDefinition>()
  const metadata = new Map<string, HeldReturnVectors>()
  const settled = new Map<string, HeldVectorSettings>()
  const unwatchers: Array<() => void> = []
  let eventsReceived = 0
  let watching = false

  function settle(indexName: string): void {
    eventsReceived += 1
    const schema = schemas.get(indexName)
    const known = metadata.get(indexName)
    if (schema === undefined || known === undefined) {
      settled.delete(indexName)
      return
    }
    settled.set(indexName, {
      indexUuid: known.indexUuid,
      settings: { schema, returnVectors: known.returnVectors },
    })
  }

  function receiveSchema(indexName: string, schema: SchemaDefinition | null): void {
    if (schema === null) schemas.delete(indexName)
    else schemas.set(indexName, schema)
    settle(indexName)
  }

  function receiveMetadata(indexName: string, bytes: Uint8Array | null): void {
    let next: HeldReturnVectors | null = null
    try {
      next = bytes === null ? null : returnVectorsOfMetadata(bytes, indexName)
    } catch (error) {
      onError(error)
    }
    if (next === null) metadata.delete(indexName)
    else metadata.set(indexName, next)
    settle(indexName)
  }

  async function readLive(indexName: string): Promise<HeldVectorSettings | null> {
    const eventsBefore = eventsReceived
    const [schema, snapshot] = await Promise.all([
      coordinator.getSchema(indexName),
      readIndexMetadataSnapshot(coordinator, indexName),
    ])
    if (schema === null || snapshot === null) return null
    const live: HeldVectorSettings = {
      indexUuid: snapshot.record.indexUuid,
      settings: { schema, returnVectors: snapshot.settings?.returnVectors === true },
    }
    if (watching && eventsReceived === eventsBefore) {
      schemas.set(indexName, schema)
      metadata.set(indexName, { indexUuid: live.indexUuid, returnVectors: live.settings.returnVectors === true })
      settled.set(indexName, live)
    }
    return live
  }

  async function settingsOf(indexName: string, allocation: AllocationTable): Promise<VectorReadSettings> {
    const held = settled.get(indexName)
    if (watching && held !== undefined && servesAllocation(held, allocation)) return held.settings
    let live: HeldVectorSettings | null
    try {
      live = await readLive(indexName)
    } catch (error) {
      if (held !== undefined) return held.settings
      throw error
    }
    return live?.settings ?? NO_KNOWN_VECTOR_FIELDS
  }

  return {
    settingsOf,
    async start() {
      if (watching) return
      unwatchers.push(await coordinator.watchSchemas(event => receiveSchema(event.indexName, event.schema)))
      unwatchers.push(await coordinator.watchIndexMetadata(event => receiveMetadata(event.indexName, event.metadata)))
      watching = true
      for (const indexName of await coordinator.listSchemas()) {
        if (!watching) return
        if (settled.has(indexName)) continue
        await readLive(indexName).catch(onError)
      }
    },
    stop() {
      watching = false
      for (const unwatch of unwatchers.splice(0)) unwatch()
      schemas.clear()
      metadata.clear()
      settled.clear()
    },
  }
}

export function keepsAnyVectorField(projection: ResolvedProjection, settings: VectorReadSettings): boolean {
  return vectorFieldSegmentsOf(settings.schema).some(field => projectionKeepsField(projection, field.join('.')))
}
