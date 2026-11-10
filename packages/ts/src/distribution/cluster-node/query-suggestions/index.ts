import { ErrorCodes, NarsilError } from '../../../errors'
import { QUERY_HISTORY_FOLDER, RESTORE_STAGING_INFIX } from '../../../query-suggestions/constants'
import { type HistoryFiles, historyFilesOf, removeHistoryFolder } from '../../../query-suggestions/history-files'
import { querySuggestionsOf } from '../../../query-suggestions/operations'
import { bindQuerySuggestions } from '../../../query-suggestions/providers'
import {
  createQuerySuggestionsRuntime,
  keyBytesOf,
  type QuerySuggestionsRuntime,
} from '../../../query-suggestions/runtime'
import type { Narsil } from '../../../types/engine'
import type { IndexConfig } from '../../../types/schema'
import type { ClusterQueryHistory } from '../../backups/query-history'
import type { ControllerMessageHandler } from '../../cluster/controller/types'
import { type RespondFn, SuggestionMessageTypes, type TransportMessage } from '../../transport/types'
import { awaitTornDownCopy } from '../drop-acknowledgement'
import type { ClusterLocalEngine } from '../local-engine'
import type { ClusterNodeConfig, CreateIndexOptions } from '../types'
import { routeCreateIndex } from '../write-routing'
import { createClusterQueryHistory } from './backup-history'
import { deleteClusterBuildRecord } from './build-records'
import { CONTROLLER_LEASE_CHECK_INTERVAL_MS } from './constants'
import { createClusterHost } from './host'
import { answerBuild, answerCounts } from './messages'
import { clusterQuerySuggestions } from './provider'
import { type ClusterSuggestionView, createClusterSuggestionView } from './view'

export interface ClusterSuggestionHooks {
  beforeCreate(indexName: string): Promise<void>
  beforeDrop(indexName: string): Promise<void>
  afterDrop(indexName: string): Promise<void>
}

export interface ClusterQuerySuggestionsDeps {
  config: ClusterNodeConfig
  nodeId: string
  engine: ClusterLocalEngine
  isController(): boolean
  guard(): void
  trackOp<T>(indexName: string | null, fn: () => Promise<T>): Promise<T>
  isOrphaned(indexName: string): boolean
  onError(error: unknown): void
}

export interface ClusterNodeHandle {
  engine: Narsil
  dropIndex(indexName: string): Promise<void>
}

export interface ClusterQuerySuggestions {
  hooks: ClusterSuggestionHooks
  queryHistory: ClusterQueryHistory
  controllerMessages: ControllerMessageHandler
  answerCounts(message: TransportMessage, respond: RespondFn): Promise<void>
  bind(owner: object, node: ClusterNodeHandle): void
  start(): Promise<void>
  stop(): Promise<void>
}

async function removeOrphanFolders(files: HistoryFiles, view: ClusterSuggestionView): Promise<void> {
  const prefix = `${QUERY_HISTORY_FOLDER}/`
  const names = new Set<string>()
  for (const key of await files.listUnder(prefix)) {
    const rest = key.slice(prefix.length)
    const end = rest.indexOf('/')
    if (end > 0 && !rest.startsWith(RESTORE_STAGING_INFIX)) names.add(rest.slice(0, end))
  }
  for (const name of names) {
    if (view.get(name) === null && (await view.refresh(name)) === null) await removeHistoryFolder(files, name)
  }
}

export function createClusterQuerySuggestions(deps: ClusterQuerySuggestionsDeps): ClusterQuerySuggestions {
  const { config, nodeId, onError } = deps
  const keySetting = config.engine?.querySuggestions?.key
  const key = keySetting === undefined ? null : keyBytesOf(keySetting)
  const files = historyFilesOf(deps.engine.historyStorage())
  let runtime: QuerySuggestionsRuntime | null = null
  let node: ClusterNodeHandle | null = null
  let leaseTimer: ReturnType<typeof setInterval> | null = null
  let wasController = false

  const view = createClusterSuggestionView(
    config.coordinator,
    {
      onGone(indexName) {
        void runtime?.onDrop(indexName).catch(onError)
      },
      onSettingChanged(indexName, previous, next) {
        if (runtime === null) return
        if (previous?.querySuggestions?.enabled === true && next?.querySuggestions?.enabled !== true) {
          void runtime.discardHistory(indexName).catch(onError)
        }
        runtime.settingChanged(indexName)
      },
    },
    onError,
  )

  function requireRuntime(): Promise<QuerySuggestionsRuntime> {
    deps.guard()
    if (runtime === null) {
      return Promise.reject(
        new NarsilError(
          ErrorCodes.NODE_NOT_READY,
          `Node '${nodeId}' has yet to start, so it serves no popular query suggestions`,
          { nodeId },
        ),
      )
    }
    return Promise.resolve(runtime)
  }

  function createMarkedIndex(
    name: string,
    indexConfig: IndexConfig,
    options: CreateIndexOptions,
    source: { index: string; group: string },
  ) {
    return deps.trackOp(name, async () => {
      if (!deps.isOrphaned(name)) await awaitTornDownCopy(deps.engine, config.coordinator, name)
      await routeCreateIndex(name, indexConfig, options, config.coordinator, deps.engine, {
        querySuggestionsSource: source,
      })
    })
  }

  async function dropMarkedIndexes(indexName: string): Promise<void> {
    if (node === null) return
    for (const name of view.names()) {
      if (name !== indexName && view.get(name)?.state?.querySuggestionsSource?.index === indexName) {
        await node.dropIndex(name)
      }
    }
  }

  async function forgetIndex(indexName: string): Promise<void> {
    await deleteClusterBuildRecord(config.coordinator, indexName)
    if (runtime !== null) await runtime.onDrop(indexName)
    else await removeHistoryFolder(files, indexName)
  }

  const counts = { nodeId, files, saveDay: (indexName: string) => runtime?.saveDay(indexName) ?? Promise.resolve() }
  const buildAnswers = { nodeId, isActive: deps.isController, runtime: requireRuntime, refresh: view.refresh, onError }

  async function clearLeftoversOfName(indexName: string): Promise<void> {
    if (view.get(indexName) !== null || (await view.refresh(indexName)) !== null) return
    await dropMarkedIndexes(indexName)
    await forgetIndex(indexName)
  }

  return {
    hooks: {
      beforeCreate: clearLeftoversOfName,
      beforeDrop: dropMarkedIndexes,
      afterDrop: forgetIndex,
    },
    queryHistory: createClusterQueryHistory({
      config,
      nodeId,
      files,
      view,
      runtime: () => runtime,
      engine: () => node?.engine ?? null,
      clearName: clearLeftoversOfName,
    }),
    controllerMessages(message, respond) {
      if (message.type === SuggestionMessageTypes.COUNTS) {
        answerCounts(counts, message, respond).catch(onError)
        return true
      }
      return answerBuild(buildAnswers, message, respond)
    },
    answerCounts: (message, respond) => answerCounts(counts, message, respond),
    bind(owner, handle) {
      node = handle
      const base = querySuggestionsOf(requireRuntime)
      const bound = clusterQuerySuggestions(
        { config, nodeId, view, isController: deps.isController, guard: deps.guard },
        base,
      )
      bindQuerySuggestions(owner, () => bound)
    },
    async start() {
      await view.start()
      await removeOrphanFolders(files, view).catch(onError)
      if (node === null) return
      const host = createClusterHost({
        config,
        nodeId,
        files,
        view,
        engine: node.engine,
        createMarkedIndex,
        isController: deps.isController,
        emit: (name, payload) => deps.engine.emitEvent(name, payload),
      })
      const started = await createQuerySuggestionsRuntime(host, key)
      runtime = started
      await started.start()
      leaseTimer = setInterval(() => {
        const isController = deps.isController()
        if (isController && !wasController) void started.timers.catchUpMissedBuilds().catch(onError)
        wasController = isController
      }, CONTROLLER_LEASE_CHECK_INTERVAL_MS)
      leaseTimer.unref?.()
    },
    async stop() {
      if (leaseTimer !== null) clearInterval(leaseTimer)
      leaseTimer = null
      await runtime?.stop()
      view.stop()
    },
  }
}
