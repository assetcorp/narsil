import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { ORACLE_TIMEOUT_MS } from './constants'
import { runCommand } from './engines/commands'
import { ORACLE_PYTHON, ORACLE_REQUIREMENTS, ORACLE_ROOT } from './paths'

const ORACLE_MODULE = 'engine_languages_oracle'
const EXIT_PASSED = 0
const EXIT_FAILED = 1

export interface OutputVerdict {
  source: string
  engine: string
  workload: string
  threads: number
  failureCount: number
  recall10: number | null
  recall100: number | null
  hybridRecall10: number | null
  maxVectorScoreError: number | null
}

export interface CrossEngineComparison {
  metric: string
  engines: [string, string]
  builds: [number, number]
  meanDifference: number
  standardError: number
  bound: number
  passed: boolean
}

export interface Verdict {
  passed: boolean
  failures: string[]
  outputs: OutputVerdict[]
  crossEngine: CrossEngineComparison[]
  oracle: { python: string; snowballstemmer: string; englishRevision: string }
}

export async function ensureOracle(): Promise<void> {
  if (existsSync(ORACLE_PYTHON)) return
  console.log('Installing the oracle into oracle/.venv')
  await runCommand('python3', ['-m', 'venv', '.venv'], { cwd: ORACLE_ROOT })
  await runCommand(ORACLE_PYTHON, ['-m', 'pip', 'install', '--quiet', '--require-hashes', '-r', ORACLE_REQUIREMENTS], {
    cwd: ORACLE_ROOT,
  })
}

export function runOracle(
  workload: string,
  truth: string,
  verdictPath: string,
  outputs: readonly string[],
): Promise<Verdict> {
  return new Promise((done, fail) => {
    const child = spawn(
      ORACLE_PYTHON,
      ['-m', ORACLE_MODULE, '--workload', workload, '--truth', truth, '--verdict', verdictPath, ...outputs],
      { cwd: ORACLE_ROOT, stdio: ['ignore', 'inherit', 'inherit'] },
    )
    const timer = setTimeout(() => child.kill('SIGKILL'), ORACLE_TIMEOUT_MS)
    child.on('error', error => {
      clearTimeout(timer)
      fail(new Error(`the oracle could not start: ${error.message}`))
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (code !== EXIT_PASSED && code !== EXIT_FAILED) {
        fail(new Error(`the oracle could not check the outputs (exit ${code}); its message is above`))
        return
      }
      const verdict = JSON.parse(readFileSync(verdictPath, 'utf-8')) as Verdict
      if (code === EXIT_FAILED || !verdict.passed) {
        fail(new Error(`the oracle rejected the run:\n${verdict.failures.slice(0, 40).join('\n')}`))
        return
      }
      done(verdict)
    })
  })
}
