import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNarsil, isNarsilError, type Narsil, type NarsilConfig, registerLanguage } from '@delali/narsil'
import {
  type CorsOptions,
  createServer,
  InMemoryTaskStore,
  type NarsilServer,
  PersistenceTaskStore,
  type ServerOptions,
  type TaskStore,
} from '@delali/narsil/server'
import { createAccessHook, createCredentialVerifier, createQueryIdentity } from './access'
import { buildAdapters } from './adapters'
import { createEventSink, deliveryBody, engineEventHandlers, TaskEventStore } from './events/publish'
import { MissingLanguageError, registerLanguages } from './languages/load'
import type { ContainerSettings } from './settings'
import {
  INDEXES_FOLDER,
  MEMORY_MODELS_FOLDER,
  MODELS_FOLDER,
  TASKS_FOLDER,
  WEBHOOKS_FOLDER,
} from './settings/constants'
import { limitVariableOf } from './settings/limits'
import { SettingError } from './settings/variables'
import { createRecordPersistence } from './storage'
import { reconcileLocalTasks } from './storage/tasks'
import { MemoryDeliveryStore, PersistedDeliveryStore } from './webhooks/delivery-store'
import { WebhookQueue } from './webhooks/queue'

export interface Output {
  event(line: string): void
  notice(line: string): void
}

export interface RunningNode {
  server: NarsilServer
  stop(): Promise<void>
}

export class StartupError extends Error {
  constructor(readonly line: string) {
    super(line)
    this.name = 'StartupError'
  }
}

interface Folders {
  indexes: string | null
  tasks: string | null
  webhooks: string | null
  models: string
}

const WORKER_BOOTSTRAP_MODULE = new URL('./worker-languages.mjs', import.meta.url).href

async function prepareFolders(settings: ContainerSettings): Promise<Folders> {
  if (settings.storage.kind === 'memory') {
    return { indexes: null, tasks: null, webhooks: null, models: join(tmpdir(), MEMORY_MODELS_FOLDER) }
  }
  const root = settings.storage.dataDir
  const folders: Folders = {
    indexes: join(root, INDEXES_FOLDER),
    tasks: join(root, TASKS_FOLDER),
    webhooks: join(root, WEBHOOKS_FOLDER),
    models: join(root, MODELS_FOLDER),
  }
  try {
    for (const folder of [folders.indexes, folders.tasks, folders.webhooks, folders.models]) {
      if (folder !== null) await mkdir(folder, { recursive: true })
    }
  } catch {
    throw new StartupError('NARSIL_DATA_DIR must be a folder that this process can write')
  }
  return folders
}

function corsOf(settings: ContainerSettings): boolean | CorsOptions | undefined {
  const cors = settings.network.cors
  if (cors === null) return undefined
  return cors.kind === 'any' ? true : { origin: cors.origins }
}

function engineConfig(
  settings: ContainerSettings,
  folders: Folders,
  events: NarsilConfig['events'],
  adapters: Awaited<ReturnType<typeof buildAdapters>>,
): NarsilConfig {
  const { workers, promotionThreshold } = settings.engine
  const config: NarsilConfig = {
    events,
    embeddingAdapters: adapters.embeddingAdapters,
    rerankAdapters: adapters.rerankAdapters,
    workers:
      workers === 0
        ? { enabled: false }
        : {
            ...(workers === undefined ? {} : { enabled: true, count: workers }),
            ...(promotionThreshold === undefined ? {} : { promotionThreshold }),
            bootstrapModule: WORKER_BOOTSTRAP_MODULE,
          },
  }
  if (settings.querySuggestions !== null) config.querySuggestions = { key: settings.querySuggestions.key }
  if (settings.limits.maxRerankWindow !== undefined) config.maxRerankWindow = settings.limits.maxRerankWindow
  if (folders.indexes !== null) {
    config.durability = { tier: 'wal', directory: folders.indexes, mode: settings.storage.durabilityMode }
  }
  return config
}

async function createEngine(config: NarsilConfig): Promise<Narsil> {
  try {
    return await createNarsil(config)
  } catch (err) {
    if (isNarsilError(err) && err.code === 'LANGUAGE_NOT_SUPPORTED') {
      const { indexName, language } = err.details ?? {}
      if (typeof indexName === 'string' && typeof language === 'string') {
        throw new StartupError(`NARSIL_LANGUAGES must name ${language}, because the saved index ${indexName} needs it`)
      }
    }
    const message = err instanceof Error ? err.message : String(err)
    throw new StartupError(`The engine failed to start: ${message}`)
  }
}

function taskStoreOf(folders: Folders): TaskStore {
  if (folders.tasks === null) return new InMemoryTaskStore()
  return new PersistenceTaskStore(createRecordPersistence(folders.tasks))
}

function serverOptions(settings: ContainerSettings, taskStore: TaskStore): ServerOptions {
  const hasKey = settings.keys.admin !== null || settings.keys.read !== null
  const verifier = createCredentialVerifier(settings.keys)
  return {
    host: settings.network.host,
    port: settings.network.port,
    cors: corsOf(settings),
    ...(hasKey ? { onRequest: createAccessHook(verifier) } : {}),
    build: {
      ...(settings.build.version === undefined ? {} : { version: settings.build.version }),
      ...(settings.build.gitSha === undefined ? {} : { gitSha: settings.build.gitSha }),
    },
    limits: settings.limits,
    taskStore,
    instanceId: settings.network.instanceId,
    allowInsecure: settings.network.allowInsecure,
    allowRegex: settings.engine.allowRegex,
    sync: settings.sync,
    changes: settings.changes,
    ...(settings.querySuggestions === null ? {} : { querySuggestions: createQueryIdentity(verifier) }),
  }
}

function serverOrStartupError(engine: Narsil, options: ServerOptions): NarsilServer {
  try {
    return createServer(engine, options)
  } catch (err) {
    if (isNarsilError(err)) {
      const variable = limitVariableOf(err.details?.field)
      if (variable !== null) throw new StartupError(`${variable} breaks its rule: ${err.message}`)
    }
    throw err
  }
}

async function startQueue(settings: ContainerSettings, folders: Folders, output: Output): Promise<WebhookQueue | null> {
  const webhook = settings.webhook
  if (webhook === null) return null
  const store =
    folders.webhooks === null
      ? new MemoryDeliveryStore()
      : new PersistedDeliveryStore(createRecordPersistence(folders.webhooks))
  const queue = new WebhookQueue({
    url: webhook.url,
    secret: webhook.secret,
    events: webhook.events,
    store,
    report: (type, data) => output.event(deliveryBody(type, data, Date.now())),
  })
  await queue.start()
  return queue
}

export async function startNode(settings: ContainerSettings, output: Output): Promise<RunningNode> {
  try {
    await registerLanguages(settings.engine.languages, registerLanguage)
  } catch (err) {
    if (err instanceof MissingLanguageError) {
      throw new StartupError(`NARSIL_LANGUAGES names ${err.language}, and this image holds no module of that name`)
    }
    throw err
  }
  const folders = await prepareFolders(settings)
  const queue = await startQueue(settings, folders, output)
  const sink = createEventSink(output.event, queue, settings.webhook?.events ?? null)
  const adapters = await buildAdapters(settings.embedders, settings.rerankers, folders.models)
  const engine = await createEngine(engineConfig(settings, folders, engineEventHandlers(sink), adapters))
  const taskStore = new TaskEventStore(taskStoreOf(folders), sink)
  let server: NarsilServer
  try {
    await reconcileLocalTasks(taskStore)
    server = serverOrStartupError(engine, serverOptions(settings, taskStore))
    await server.listen()
  } catch (err) {
    await engine.shutdown().catch(() => undefined)
    await queue?.close()
    if (err instanceof StartupError || err instanceof SettingError) throw err
    const message = err instanceof Error ? err.message : String(err)
    throw new StartupError(`The server failed to start: ${message}`)
  }
  return {
    server,
    async stop() {
      try {
        await server.shutdown()
      } finally {
        await Promise.allSettled([queue?.close(), taskStore.shutdown()])
      }
    },
  }
}
