import { execFile } from 'node:child_process'
import { BUILD_TIMEOUT_MS, VERSION_PROBE_TIMEOUT_MS } from '../constants'

const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024 * 1024
const FAILURE_TAIL_CHARACTERS = 4_000

export interface CommandOptions {
  cwd: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

export function runCommand(command: string, args: readonly string[], options: CommandOptions): Promise<string> {
  return new Promise((done, fail) => {
    execFile(
      command,
      [...args],
      {
        cwd: options.cwd,
        env: options.env ?? process.env,
        timeout: options.timeoutMs ?? BUILD_TIMEOUT_MS,
        maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error) {
          const tail = `${stdout}\n${stderr}`.trim().slice(-FAILURE_TAIL_CHARACTERS)
          fail(new Error(`${command} ${args.join(' ')} failed in ${options.cwd}: ${error.message}\n${tail}`))
          return
        }
        done(`${stdout}${stderr}`)
      },
    )
  })
}

export async function firstLineOf(command: string, args: readonly string[], cwd: string): Promise<string> {
  try {
    const output = await runCommand(command, args, { cwd, timeoutMs: VERSION_PROBE_TIMEOUT_MS })
    return output.split('\n')[0]?.trim() || 'unknown'
  } catch {
    return 'unknown'
  }
}
