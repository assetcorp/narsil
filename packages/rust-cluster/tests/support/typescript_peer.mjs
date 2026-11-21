import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const repositoryRoot = process.argv[2]
const transportDirectory = join(repositoryRoot, 'packages/ts/dist/distribution/transport')
const { createTcpTransport } = await import(pathToFileURL(join(transportDirectory, 'tcp.mjs')).href)
const { createGrpcTransport } = await import(pathToFileURL(join(transportDirectory, 'grpc.mjs')).href)

const STREAM_CHUNKS = 3

function handle(message, respond) {
  if (message.type === 'test.fail') throw new Error('The TypeScript listener refused the request')
  if (message.type === 'test.stream') {
    for (let chunk = 1; chunk <= STREAM_CHUNKS; chunk++) {
      respond({ ...message, sourceId: 'typescript-peer', payload: new Uint8Array([chunk]) })
    }
    return
  }
  respond({ type: 'test.echo', sourceId: message.sourceId, requestId: message.requestId, payload: message.payload })
}

const config = { host: '127.0.0.1', port: 0 }
const tcp = createTcpTransport('typescript-peer', config)
const grpc = await createGrpcTransport('typescript-peer', config)
await tcp.listen(handle)
await grpc.listen(handle)
process.stdout.write(`PORTS ${tcp.getPort()} ${grpc.getPort()}\n`)

process.stdin.resume()
process.stdin.on('end', async () => {
  await tcp.shutdown()
  await grpc.shutdown()
  process.exit(0)
})
