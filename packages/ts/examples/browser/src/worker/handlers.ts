import {
  type AnyDocument,
  ErrorCodes,
  isNarsilError,
  type Narsil,
  type QueryParams,
  type QueryResult,
} from '@delali/narsil'
import { readStreamBytes } from '@delali/narsil-example-shared/lib/bounded-read'
import { loadDataset } from './datasets'
import { describeSessions, isSyncedElsewhere, pauseSync, startSync, stopSync, writeThroughSync } from './device-sync'
import type { QueryExtras, WorkerArgs, WorkerMethod } from './protocol'
import { relayWrite } from './sync-relay'

type Handlers = { [K in WorkerMethod]: (engine: Narsil, args: WorkerArgs<K>) => Promise<unknown> }

export type ProgressSink = Parameters<typeof loadDataset>[2]

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
  return (await readStreamBytes(stream)) ?? new Uint8Array(0)
}

function numberIn(document: AnyDocument, field: string): number {
  const value = (document as Record<string, unknown>)[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function query(engine: Narsil, indexName: string, params: QueryParams, extras: QueryExtras): Promise<QueryResult> {
  const totalField = extras.groupTotalField
  if (totalField === null || params.group === undefined) return engine.query(indexName, params)
  return engine.query(indexName, {
    ...params,
    group: {
      ...params.group,
      reduce: {
        reducer: (total, document) => (total as number) + numberIn(document, totalField),
        initialValue: () => 0,
      },
    },
  })
}

async function writeDocument(
  engine: Narsil,
  indexName: string,
  documentId: string,
  document: AnyDocument | null,
): Promise<null> {
  if (await writeThroughSync(indexName, documentId, document)) return null
  if (await isSyncedElsewhere(indexName)) {
    await relayWrite(indexName, documentId, document)
    return null
  }
  if (document === null) {
    await engine.remove(indexName, documentId)
  } else {
    await putDocument(engine, indexName, documentId, document)
  }
  await engine.checkpoint(indexName)
  return null
}

async function putDocument(engine: Narsil, indexName: string, documentId: string, document: AnyDocument) {
  try {
    await engine.insert(indexName, document, documentId)
  } catch (err) {
    if (!isNarsilError(err) || err.code !== ErrorCodes.DOC_ALREADY_EXISTS) throw err
    await engine.update(indexName, documentId, document)
  }
}

async function changed(engine: Narsil, indexName: string, change: Promise<unknown>): Promise<null> {
  await change
  await engine.checkpoint(indexName)
  return null
}

export function createHandlers(report: ProgressSink): Handlers {
  return {
    loadDataset: (engine, [request]) => loadDataset(engine, request, report),
    query: (engine, [indexName, params, extras]) => query(engine, indexName, params, extras),
    preflight: (engine, [indexName, params]) => engine.preflight(indexName, params),
    suggest: (engine, [indexName, params]) => engine.suggest(indexName, params),
    listDocuments: (engine, [indexName, params]) => engine.listDocuments(indexName, params),
    getDocument: async (engine, [indexName, documentId]) => (await engine.get(indexName, documentId)) ?? null,
    saveDocument: (engine, [indexName, documentId, document]) => writeDocument(engine, indexName, documentId, document),
    removeDocument: (engine, [indexName, documentId]) => writeDocument(engine, indexName, documentId, null),
    getStats: (engine, [indexName]) => Promise.resolve(engine.getStats(indexName)),
    getPartitionStats: (engine, [indexName]) => Promise.resolve(engine.getPartitionStats(indexName)),
    getMemoryStats: engine => engine.getMemoryStats(),
    vectorMaintenanceStatus: (engine, [indexName]) => Promise.resolve(engine.vectorMaintenanceStatus(indexName)),
    listIndexes: engine => Promise.resolve(engine.listIndexes()),
    dropIndex: async (engine, [indexName]) => {
      await stopSync(indexName)
      await engine.dropIndex(indexName)
      return null
    },
    getSynonyms: (engine, [indexName]) => engine.getSynonyms(indexName),
    updateSynonyms: (engine, [indexName, rules]) => changed(engine, indexName, engine.updateSynonyms(indexName, rules)),
    changeAnalysis: (engine, [indexName, change]) =>
      changed(engine, indexName, engine.changeAnalysis(indexName, change)),
    rebalance: (engine, [indexName, count]) => changed(engine, indexName, engine.rebalance(indexName, count)),
    updatePartitionConfig: (engine, [indexName, config]) =>
      changed(engine, indexName, engine.updatePartitionConfig(indexName, config)),
    compactVectors: (engine, [indexName]) => changed(engine, indexName, engine.compactVectors(indexName)),
    optimizeVectors: (engine, [indexName]) => changed(engine, indexName, engine.optimizeVectors(indexName)),
    snapshot: async (engine, [indexName]) => readAll(await engine.snapshot(indexName)),
    restore: (engine, [indexName, archive]) => changed(engine, indexName, engine.restore(indexName, archive)),
    exportDocuments: async (engine, [indexName]) => readAll(await engine.exportDocuments(indexName)),
    importDocumentExport: (engine, [indexName, archive]) =>
      changed(engine, indexName, engine.importDocumentExport(indexName, archive)),
    startSync: (engine, [request]) => startSync(engine, request),
    stopSync: (_engine, [indexName]) => stopSync(indexName),
    syncStatus: () => Promise.resolve(describeSessions()),
    openNotes: async (engine, [request]) => {
      if (!engine.listIndexes().some(index => index.name === request.indexName)) {
        await engine.createIndex(request.indexName, {
          schema: { title: 'string', body: 'string' },
          language: 'english',
        })
        await engine.checkpoint(request.indexName)
      }
      return startSync(engine, request)
    },
    pauseSync: (_engine, [indexName, paused]) => pauseSync(indexName, paused),
  }
}
