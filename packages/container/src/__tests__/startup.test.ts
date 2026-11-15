import { afterAll, describe, expect, it } from 'vitest'
import {
  ADMIN_KEY,
  call,
  type Env,
  READ_KEY,
  removeFolder,
  runToExit,
  startNode,
  temporaryFolder,
} from './support/node'

const SHORT_SECRET_KEY = 'short-admin-key-value'
const WEBHOOK_SECRET_BAD = 'whsec_bm90LWVub3VnaC1ieXRlcw=='
const SUGGESTIONS_KEY_SHORT = 'suggestions-key-too-short'

const folder = temporaryFolder('startup')

afterAll(() => removeFolder(folder))

function memoryEnv(extra: Env): Env {
  return { NARSIL_STORAGE: 'memory', NARSIL_WORKERS: '0', NARSIL_ADMIN_KEY: ADMIN_KEY, ...extra }
}

interface Refusal {
  label: string
  env: Env
  variable: string
  secret?: string
}

const REFUSALS: Refusal[] = [
  ...(['EMBEDDER', 'RERANKER'] as const).flatMap(family => {
    const prefix = `NARSIL_${family}_LOCAL_`
    const env = memoryEnv({
      [`NARSIL_${family === 'EMBEDDER' ? 'EMBEDDERS' : 'RERANKERS'}`]: 'local',
      [`${prefix}KIND`]: family === 'EMBEDDER' ? 'openai' : 'http',
      [`${prefix}URL`]: 'http://127.0.0.1:9',
      [`${prefix}MODEL`]: 'local',
      ...(family === 'EMBEDDER' ? { [`${prefix}DIMENSIONS`]: '2' } : {}),
    })
    return [
      { field: 'URL', value: 'http://private-user:private-password@127.0.0.1:9' },
      { field: 'URL', value: 'http://127.0.0.1:9/#fragment' },
      { field: 'URL', value: 'http://127.0.0.1:9/?' },
      { field: 'URL', value: 'http://127.0.0.1:9/#' },
      { field: 'MODEL', value: '   ' },
      { field: 'API_KEY', value: 'private-key\r\ninjected-header: secret' },
      { field: 'API_KEY', value: 'private-key\u0001' },
      { field: 'API_KEY', value: 'private-key\u007f' },
    ].map(({ field, value }) => ({
      label: `an unusable ${family} ${field}`,
      env: { ...env, [`${prefix}${field}`]: value },
      variable: `${prefix}${field}`,
      secret: value,
    }))
  }),
  {
    label: 'no key and no insecure opt-in',
    env: { NARSIL_STORAGE: 'memory', NARSIL_WORKERS: '0' },
    variable: 'NARSIL_ADMIN_KEY',
  },
  {
    label: 'an admin key shorter than 32 characters',
    env: memoryEnv({ NARSIL_ADMIN_KEY: SHORT_SECRET_KEY }),
    variable: 'NARSIL_ADMIN_KEY',
    secret: SHORT_SECRET_KEY,
  },
  {
    label: 'a read key equal to the admin key',
    env: memoryEnv({ NARSIL_READ_KEY: ADMIN_KEY }),
    variable: 'NARSIL_READ_KEY',
    secret: ADMIN_KEY,
  },
  { label: 'a port above 65535', env: memoryEnv({ NARSIL_HTTP_PORT: '70000' }), variable: 'NARSIL_HTTP_PORT' },
  { label: 'a port with a sign', env: memoryEnv({ NARSIL_HTTP_PORT: '+8080' }), variable: 'NARSIL_HTTP_PORT' },
  {
    label: 'device sync with no key',
    env: { NARSIL_STORAGE: 'memory', NARSIL_ALLOW_INSECURE: 'true', NARSIL_SYNC: 'true' },
    variable: 'NARSIL_SYNC',
  },
  {
    label: 'a change feed with no key',
    env: { NARSIL_STORAGE: 'memory', NARSIL_ALLOW_INSECURE: 'true', NARSIL_CHANGES: 'true' },
    variable: 'NARSIL_CHANGES',
  },
  {
    label: 'a boolean other than true or false',
    env: memoryEnv({ NARSIL_ALLOW_REGEX: 'yes' }),
    variable: 'NARSIL_ALLOW_REGEX',
  },
  {
    label: 'a list with an empty item',
    env: memoryEnv({ NARSIL_LANGUAGES: 'english,,french' }),
    variable: 'NARSIL_LANGUAGES',
  },
  {
    label: 'a language that the image lacks',
    env: memoryEnv({ NARSIL_LANGUAGES: 'english,klingon' }),
    variable: 'NARSIL_LANGUAGES',
  },
  {
    label: 'a webhook URL without a secret',
    env: memoryEnv({ NARSIL_WEBHOOK_URL: 'http://127.0.0.1:9/hook' }),
    variable: 'NARSIL_WEBHOOK_SECRET',
  },
  {
    label: 'a webhook secret shorter than 24 bytes',
    env: memoryEnv({ NARSIL_WEBHOOK_URL: 'http://127.0.0.1:9/hook', NARSIL_WEBHOOK_SECRET: WEBHOOK_SECRET_BAD }),
    variable: 'NARSIL_WEBHOOK_SECRET',
    secret: WEBHOOK_SECRET_BAD,
  },
  {
    label: 'a webhook event type that does not exist',
    env: memoryEnv({ NARSIL_WEBHOOK_EVENTS: 'engine.write' }),
    variable: 'NARSIL_WEBHOOK_EVENTS',
  },
  {
    label: 'two embedders with the same infix',
    env: memoryEnv({ NARSIL_EMBEDDERS: 'open-ai,open_ai' }),
    variable: 'NARSIL_EMBEDDERS',
  },
  {
    label: 'an openai embedder without a URL',
    env: memoryEnv({
      NARSIL_EMBEDDERS: 'remote',
      NARSIL_EMBEDDER_REMOTE_KIND: 'openai',
      NARSIL_EMBEDDER_REMOTE_MODEL: 'text-embedding-3-small',
      NARSIL_EMBEDDER_REMOTE_DIMENSIONS: '8',
    }),
    variable: 'NARSIL_EMBEDDER_REMOTE_URL',
  },
  {
    label: 'an embedder without dimensions',
    env: memoryEnv({ NARSIL_EMBEDDERS: 'local', NARSIL_EMBEDDER_LOCAL_KIND: 'transformers' }),
    variable: 'NARSIL_EMBEDDER_LOCAL_DIMENSIONS',
  },
  {
    label: 'query suggestions with a key below 32 bytes',
    env: memoryEnv({ NARSIL_QUERY_SUGGESTIONS: 'true', NARSIL_QUERY_SUGGESTIONS_KEY: SUGGESTIONS_KEY_SHORT }),
    variable: 'NARSIL_QUERY_SUGGESTIONS_KEY',
    secret: SUGGESTIONS_KEY_SHORT,
  },
  {
    label: 'an import batch size of zero',
    env: memoryEnv({ NARSIL_LIMIT_IMPORT_BATCH_SIZE: '0' }),
    variable: 'NARSIL_LIMIT_IMPORT_BATCH_SIZE',
  },
  {
    label: 'a rerank window above what the engine accepts',
    env: memoryEnv({ NARSIL_LIMIT_MAX_RERANK_WINDOW: '1000000' }),
    variable: 'NARSIL_LIMIT_MAX_RERANK_WINDOW',
  },
  {
    label: 'a body fraction above one',
    env: memoryEnv({ NARSIL_LIMIT_MAX_BODY_BYTES_IN_FLIGHT_FRACTION: '1.5' }),
    variable: 'NARSIL_LIMIT_MAX_BODY_BYTES_IN_FLIGHT_FRACTION',
  },
]

describe('the startup program refuses a bad setting before it binds the port', () => {
  it.each(REFUSALS)('exits 1 for $label, naming the variable and printing no secret', async refusal => {
    const exit = await runToExit({ NARSIL_DATA_DIR: folder, ...refusal.env })
    expect(exit.code).toBe(1)
    const lines = exit.stderr.split('\n').filter(line => line.length > 0 && !line.startsWith('Warning:'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(refusal.variable)
    if (refusal.secret !== undefined) {
      expect(exit.stderr).not.toContain(refusal.secret)
      expect(exit.stdout).not.toContain(refusal.secret)
    }
  })
})

describe('a limit set through its variable', () => {
  it('refuses a body above NARSIL_LIMIT_MAX_BODY_BYTES with 413 and keeps serving', async () => {
    const node = await startNode(memoryEnv({ NARSIL_LIMIT_MAX_BODY_BYTES: '512' }))
    try {
      const created = await call(node, 'POST', '/indexes', {
        credential: ADMIN_KEY,
        body: { name: 'notes', config: { schema: { title: 'string' } } },
      })
      expect(created.status).toBe(201)
      const oversized = await call(node, 'POST', '/indexes/notes/documents', {
        credential: ADMIN_KEY,
        body: { id: 'n1', document: { title: 'x'.repeat(1_024) } },
      })
      expect(oversized.status).toBe(413)
      const fits = await call(node, 'POST', '/indexes/notes/documents', {
        credential: ADMIN_KEY,
        body: { id: 'n2', document: { title: 'short note' } },
      })
      expect(fits.status).toBe(201)
    } finally {
      expect((await node.stop()).code).toBe(0)
    }
  })
})

describe('the startup program beside a Kubernetes service named narsil', () => {
  it('warns about every unknown NARSIL_ variable and goes on serving', async () => {
    const node = await startNode(
      memoryEnv({
        NARSIL_PORT: 'tcp://10.0.0.1:7700',
        NARSIL_SERVICE_HOST: '10.0.0.1',
        NARSIL_READ_KEY: READ_KEY,
      }),
    )
    try {
      expect(node.stderr()).toContain('NARSIL_PORT')
      expect(node.stderr()).toContain('NARSIL_SERVICE_HOST')
      expect((await call(node, 'GET', '/livez')).status).toBe(200)
    } finally {
      expect((await node.stop()).code).toBe(0)
    }
  })
})
