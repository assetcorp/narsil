const { execFileSync } = require('node:child_process')
const { randomUUID } = require('node:crypto')

const IMAGE = process.argv[2]
const EXPECTED_VERSION = process.argv[3]
const EXPECTED_GIT_SHA = process.argv[4]
const CONTAINER = `narsil-image-smoke-${randomUUID()}`
const ADMIN_KEY = 'admin-key-for-the-container-image-smoke-check'
const START_TIMEOUT_MS = 60_000
const STOP_GRACE_SECONDS = 30
const POLL_INTERVAL_MS = 250
const REQUEST_TIMEOUT_MS = 5_000

const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const fail = message => {
  console.error(message)
  try {
    console.error(docker(['logs', CONTAINER]))
  } catch {}
  try {
    docker(['rm', '-f', CONTAINER])
  } catch {}
  process.exit(1)
}

let base

const waitForLiveness = async () => {
  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${base}/livez`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })).status === 200) return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  fail(`The image did not answer /livez within ${START_TIMEOUT_MS} ms`)
}

const call = async (method, path, credential, body) => {
  const headers = credential === undefined ? {} : { authorization: `Bearer ${credential}` }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}

const expectEqual = (label, actual, expected) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`)
  }
}

const main = async () => {
  if (IMAGE === undefined || EXPECTED_VERSION === undefined || EXPECTED_GIT_SHA === undefined) {
    fail('Usage: node container-image-smoke.js <image> <version> <git sha>')
  }
  docker([
    'run',
    '--detach',
    '--name',
    CONTAINER,
    '--publish',
    '127.0.0.1::7700',
    '--env',
    `NARSIL_ADMIN_KEY=${ADMIN_KEY}`,
    IMAGE,
  ])
  const port = docker(['inspect', '--format', '{{(index (index .NetworkSettings.Ports "7700/tcp") 0).HostPort}}', CONTAINER])
  base = `http://127.0.0.1:${port}`
  await waitForLiveness()

  const version = await call('GET', '/version')
  expectEqual('GET /version status', version.status, 200)
  expectEqual('build version', version.body?.version, EXPECTED_VERSION)
  expectEqual('build git sha', version.body?.gitSha, EXPECTED_GIT_SHA)
  expectEqual('vector search backend', version.body?.vectorSearch, 'native')

  expectEqual('a request without a key', (await call('GET', '/indexes')).status, 401)
  const created = await call('POST', '/indexes', ADMIN_KEY, {
    name: 'books',
    config: { schema: { title: 'string' } },
  })
  expectEqual('POST /indexes status', created.status, 201)
  const inserted = await call('POST', '/indexes/books/documents', ADMIN_KEY, {
    id: 'b1',
    document: { title: 'a winter garden' },
  })
  expectEqual('POST /indexes/books/documents status', inserted.status, 201)
  const found = await call('POST', '/indexes/books/search', ADMIN_KEY, { term: 'garden' })
  expectEqual(
    'search hits',
    found.body?.hits?.map(hit => hit.id),
    ['b1'],
  )

  expectEqual('the user that serves', docker(['exec', CONTAINER, 'id', '-u']), '1000')
  docker(['stop', '--time', String(STOP_GRACE_SECONDS), CONTAINER])
  expectEqual('exit status after SIGTERM', docker(['inspect', '--format', '{{.State.ExitCode}}', CONTAINER]), '0')
  const logs = docker(['logs', CONTAINER])
  if (logs.includes('WebAssembly')) fail('The image searched through WebAssembly in place of the native core')
  docker(['rm', CONTAINER])
  console.log('The container image starts, answers, searches on the native core, and stops cleanly.')
}

main().catch(error => fail(error instanceof Error ? error.message : String(error)))
