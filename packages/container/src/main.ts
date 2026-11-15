import { readSettings, SettingError } from './settings'
import { type Output, type RunningNode, StartupError, startNode } from './startup'

const FAILURE_EXIT_CODE = 1
const CLEAN_EXIT_CODE = 0

const output: Output = {
  event: line => {
    process.stdout.write(`${line}\n`)
  },
  notice: line => {
    process.stderr.write(`${line}\n`)
  },
}

function fail(line: string): never {
  output.notice(line)
  process.exit(FAILURE_EXIT_CODE)
}

function failureLine(err: unknown): string {
  if (err instanceof SettingError || err instanceof StartupError) return err.message
  return `The startup program failed: ${err instanceof Error ? err.message : String(err)}`
}

function stopOnSignals(node: RunningNode): void {
  let stopping = false
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) return
    stopping = true
    output.notice(`Received ${signal}, shutting the server and the engine down`)
    node.stop().then(
      () => process.exit(CLEAN_EXIT_CODE),
      (err: unknown) => {
        output.notice(`The shutdown failed: ${err instanceof Error ? err.message : String(err)}`)
        process.exit(FAILURE_EXIT_CODE)
      },
    )
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

async function main(): Promise<void> {
  let settings: ReturnType<typeof readSettings>
  try {
    settings = readSettings(process.env)
  } catch (err) {
    fail(failureLine(err))
  }
  for (const warning of settings.warnings) output.notice(`Warning: ${warning}`)
  let node: RunningNode
  try {
    node = await startNode(settings, output)
  } catch (err) {
    fail(failureLine(err))
  }
  stopOnSignals(node)
  output.notice(`Narsil serves HTTP on ${settings.network.host}:${node.server.listeningPort}`)
}

void main()
