import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const LISTENING_LINE = /^Narsil HTTP server listening on http:\/\/[^\s]+:(\d+)$/
const settings = JSON.parse(process.env.NARSIL_CLIENT_TEST_SERVER ?? '{}')
const binary = process.env.NARSIL_RUST_SERVER_BINARY

if (typeof binary !== 'string' || binary.length === 0) {
  process.stderr.write('Set NARSIL_RUST_SERVER_BINARY to the path of a built narsil-server binary\n')
  process.exit(1)
}
if (settings.mode === 'cluster') {
  process.stderr.write('The Rust server serves one node, so it starts no cluster node\n')
  process.exit(1)
}

const environment = { ...process.env, NARSIL_HOST: '127.0.0.1', NARSIL_PORT: String(settings.httpPort ?? 0) }
for (const name of ['NARSIL_API_KEY', 'NARSIL_MAX_IMPORT_BYTES', 'NARSIL_DURABILITY_DIR']) delete environment[name]
if (typeof settings.apiKey === 'string') environment.NARSIL_API_KEY = settings.apiKey
if (typeof settings.maxImportBytes === 'number') environment.NARSIL_MAX_IMPORT_BYTES = String(settings.maxImportBytes)

const server = spawn(binary, [], { env: environment, stdio: ['ignore', 'pipe', 'inherit'] })
createInterface({ input: server.stdout }).on('line', line => {
  const listening = LISTENING_LINE.exec(line)
  process.stdout.write(listening === null ? `${line}\n` : `READY ${listening[1]}\n`)
})

const forward = signal => () => {
  if (server.exitCode === null) server.kill(signal)
}
process.on('SIGTERM', forward('SIGTERM'))
process.on('SIGINT', forward('SIGINT'))
server.on('error', failure => {
  process.stderr.write(`The Rust server did not start: ${failure.message}\n`)
  process.exit(1)
})
server.on('exit', (code, signal) => process.exit(code ?? (signal === null ? 1 : 0)))
