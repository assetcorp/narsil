import { spawn } from 'node:child_process'

const RESULT_LINE = /^RESULT (.+)$/m

export interface NodeChildOutcome {
  exitCode: number | null
  output: string
}

export function runNodeChild(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<NodeChildOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', exitCode => resolve({ exitCode, output }))
  })
}

export function resultLineOf(output: string): string | undefined {
  return RESULT_LINE.exec(output)?.[1]
}
