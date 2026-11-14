import { createChangesSettingHandlers } from '../changes/setting-handlers'
import type { HandlerDeps } from '../deps'
import { createAdminHandlers } from '../handlers/admin'
import { createBackupHandlers } from '../handlers/backups'
import { createCapabilitiesHandler } from '../handlers/capabilities'
import { createClusterHandlers } from '../handlers/cluster'
import { createDocumentExportHandlers } from '../handlers/document-export'
import { createDocumentHandlers } from '../handlers/documents'
import { createHealthHandlers } from '../handlers/health'
import { createImportHandler } from '../handlers/import'
import { createIndexHandlers } from '../handlers/indexes'
import { createMetricsHandler } from '../handlers/metrics'
import { createQuerySuggestionHandlers } from '../handlers/query-suggestions'
import { createSearchHandlers } from '../handlers/search'
import { createVersionHandler } from '../handlers/version'
import type { ServerHandlers } from '../routes'
import type { SyncServing } from '../sync/serving'
import { createSyncSettingHandlers } from '../sync/setting-handlers'
import { createSyncSnapshotHandler } from '../sync/snapshot-handler'

export function mainThreadHandlers(deps: HandlerDeps, syncServing: () => SyncServing | null): ServerHandlers {
  const idx = createIndexHandlers(deps)
  const doc = createDocumentHandlers(deps)
  const search = createSearchHandlers(deps)
  const admin = createAdminHandlers(deps)
  const documentExport = createDocumentExportHandlers(deps)
  const health = createHealthHandlers(deps)
  const cluster = createClusterHandlers(deps)
  const backups = createBackupHandlers(deps)
  const version = createVersionHandler(deps)
  const capabilities = createCapabilitiesHandler()
  const syncSetting = createSyncSettingHandlers(deps.engine)
  const changesSetting = createChangesSettingHandlers(deps.engine)
  const suggestions = createQuerySuggestionHandlers(deps, deps.querySuggestions)

  return {
    livez: health.livez,
    readyz: health.readyz,
    version: version.report,
    capabilities: capabilities.report,
    clusterTopology: cluster.topology,
    clusterAllocation: cluster.allocation,
    clusterReplicationFactor: cluster.replicationFactor,
    clusterHealth: cluster.health,
    createBackup: backups.create,
    listBackups: backups.list,
    restoreBackup: backups.restore,
    deleteBackup: backups.remove,
    metrics: createMetricsHandler(deps),
    memory: admin.memory,
    listTasks: admin.listTasks,
    getTask: admin.getTask,
    cancelTask: admin.cancelTask,
    createIndex: idx.create,
    listIndexes: idx.list,
    dropIndex: idx.drop,
    indexStats: idx.stats,
    indexPartitions: idx.partitions,
    clearIndex: idx.clear,
    openIndex: idx.open,
    closeIndex: idx.close,
    insert: doc.insert,
    batch: doc.batch,
    importNdjson: createImportHandler(deps),
    put: doc.put,
    patch: doc.patch,
    remove: doc.remove,
    waitForWrites: doc.waitForWrites,
    search: search.search,
    preflight: search.preflight,
    suggest: search.suggest,
    get: doc.get,
    exists: doc.exists,
    count: doc.count,
    list: doc.list,
    multiGet: doc.multiGet,
    checkpoint: admin.checkpoint,
    rebuildAnalysis: admin.rebuildAnalysis,
    changeAnalysis: admin.changeAnalysis,
    snapshot: admin.snapshot,
    vectorMaintenance: admin.vectorMaintenance,
    compact: admin.compact,
    optimize: admin.optimize,
    rebalance: admin.rebalance,
    partitionConfig: admin.partitionConfig,
    readSynonyms: admin.readSynonyms,
    replaceSynonyms: admin.replaceSynonyms,
    updateBm25: admin.updateBm25,
    restore: admin.restore,
    exportDocuments: documentExport.exportDocuments,
    importExport: documentExport.importExport,
    getSync: syncSetting.getSync,
    updateSync: syncSetting.updateSync,
    syncSnapshot: createSyncSnapshotHandler(syncServing),
    getChanges: changesSetting.getChanges,
    updateChanges: changesSetting.updateChanges,
    updateQuerySuggestions: suggestions.update,
    querySuggestionsStatus: suggestions.status,
    recordQuery: suggestions.record,
    buildQuerySuggestions: suggestions.build,
    previewQuerySuggestions: suggestions.preview,
    readQueryBans: suggestions.readBans,
    replaceQueryBans: suggestions.replaceBans,
    removeQuery: suggestions.remove,
    addManualSuggestion: suggestions.manual,
  }
}
