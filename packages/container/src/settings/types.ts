import type { ServerLimits } from '@delali/narsil/server'

export type CorsOrigins = { kind: 'any' } | { kind: 'list'; origins: string[] }

export interface AccessKeys {
  admin: string | null
  read: string | null
}

export interface NetworkSettings {
  host: string
  port: number
  cors: CorsOrigins | null
  allowInsecure: boolean
  instanceId: string
}

export interface StorageSettings {
  kind: 'filesystem' | 'memory'
  dataDir: string
  durabilityMode: 'sync' | 'async'
}

export interface EngineSettings {
  languages: string[]
  workers: number | undefined
  promotionThreshold: number | undefined
  allowRegex: boolean
}

export interface EmbedderSetting {
  name: string
  kind: 'openai' | 'transformers'
  url: string | undefined
  apiKey: string | undefined
  model: string
  dimensions: number
  timeoutMs: number
  maxRetries: number
}

export interface RerankerSetting {
  name: string
  kind: 'http' | 'transformers'
  url: string | undefined
  apiKey: string | undefined
  model: string
  timeoutMs: number
  maxRetries: number
  maxDocumentsPerRequest: number
}

export interface WebhookSettings {
  url: string
  secret: Uint8Array
  events: ReadonlySet<string> | null
}

export interface ContainerSettings {
  network: NetworkSettings
  keys: AccessKeys
  storage: StorageSettings
  engine: EngineSettings
  limits: ServerLimits
  embedders: EmbedderSetting[]
  rerankers: RerankerSetting[]
  sync: boolean
  changes: boolean
  querySuggestions: { key: string } | null
  webhook: WebhookSettings | null
  build: { version: string | undefined; gitSha: string | undefined }
  warnings: string[]
}
