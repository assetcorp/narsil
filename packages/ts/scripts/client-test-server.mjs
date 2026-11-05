import { createFilesystemPersistence } from '../dist/adapters/filesystem.mjs'
import { createEtcdCoordinator } from '../dist/distribution/coordinator/etcd.mjs'
import { createTcpTransport } from '../dist/distribution/transport/tcp.mjs'
import { clusterNodeEngine, createClusterNode } from '../dist/distribution.mjs'
import { createNarsil } from '../dist/index.mjs'
import { createServer } from '../dist/server.mjs'

const settings = JSON.parse(process.env.NARSIL_CLIENT_TEST_SERVER ?? '{}')

function serverOptions() {
  const options = { host: '127.0.0.1', port: settings.httpPort ?? 0 }
  if (typeof settings.apiKey === 'string') {
    const expected = `Bearer ${settings.apiKey}`
    options.onRequest = context =>
      context.headers.authorization === expected
        ? undefined
        : { status: 401, code: 'UNAUTHORIZED', message: 'The request carries no valid API key' }
  }
  if (typeof settings.maxImportBytes === 'number') {
    options.limits = { maxImportBytes: settings.maxImportBytes }
  }
  return options
}

async function startSingle() {
  const engine = await createNarsil({ workers: { enabled: false } })
  const server = createServer(engine, serverOptions())
  await server.listen()
  return {
    port: server.listeningPort,
    async stop() {
      await server.shutdown()
    },
  }
}

async function startClusterNode() {
  const coordinator = await createEtcdCoordinator({
    endpoints: settings.etcdEndpoints,
    keyPrefix: settings.keyPrefix,
    nodeHeartbeatTtlSeconds: settings.heartbeatTtlSeconds,
  })
  const transport = createTcpTransport('client-test-node', { host: '127.0.0.1', port: settings.transportPort })
  const node = await createClusterNode({
    coordinator,
    transport,
    address: `127.0.0.1:${settings.transportPort}`,
    nodeId: settings.nodeId,
    roles: ['data', 'coordinator', 'controller'],
    engine: { workers: { enabled: false }, durability: { directory: settings.directory } },
    controller: { leaseTtlMs: settings.controllerLeaseTtlMs, standbyRetryMs: settings.standbyRetryMs },
    backups: {
      store: createFilesystemPersistence({ directory: settings.backupDirectory }),
      keyPrefix: settings.keyPrefix,
    },
    onError: error => process.stderr.write(`${node.nodeId}: ${error.message}\n`),
  })
  await node.start()
  const server = createServer(
    clusterNodeEngine(node, {
      createIndex: {
        partitionCount: settings.partitionCount,
        replicationFactor: settings.replicationFactor,
        waitForServingMs: settings.waitForServingMs,
      },
    }),
    { ...serverOptions(), cluster: node.cluster },
  )
  await server.listen()
  return {
    port: server.listeningPort,
    async stop() {
      await server.close()
      await node.shutdown()
      await transport.shutdown()
      await coordinator.shutdown()
    },
  }
}

const running = settings.mode === 'cluster' ? await startClusterNode() : await startSingle()
process.stdout.write(`READY ${running.port}\n`)

let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  await running.stop()
  process.exit(0)
}

process.on('SIGTERM', () => void stop())
process.on('SIGINT', () => void stop())
