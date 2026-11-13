import { spawn } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { MAX_RUNNER_OUTPUT_BYTES, MAX_RUNNER_STDOUT_LINE_BYTES, RUNNER_TIMEOUT_MS } from '../constants'
import { MEMORY_MEASURED_LINE, MEMORY_READY_LINE, parseRunnerOutput, type RunnerOutput } from '../runner-output'
import type { WorkloadKind } from '../workload/format'
import type { EngineSpec } from './catalog'
import { type MemoryReading, readProcessMemory } from './memory'

export interface RunnerRun {
  output: RunnerOutput
  memory: MemoryReading
  outputPath: string
}

function readOutput(path: string, spec: EngineSpec, kind: WorkloadKind, threads: number): RunnerOutput {
  const size = statSync(path).size
  if (size > MAX_RUNNER_OUTPUT_BYTES) {
    throw new Error(
      `${spec.name} wrote ${size} bytes to ${path}, above the ${MAX_RUNNER_OUTPUT_BYTES} that the driver reads`,
    )
  }
  return parseRunnerOutput(readFileSync(path, 'utf-8'), { engine: spec.name, workload: kind, threads })
}

export function runRunner(
  spec: EngineSpec,
  workload: string,
  kind: WorkloadKind,
  threads: number,
  outputPath: string,
): Promise<RunnerRun> {
  return new Promise((done, fail) => {
    const child = spawn(spec.command, spec.args(workload, kind, threads, outputPath), {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ['pipe', 'pipe', 'inherit'],
    })
    const label = `${spec.name} ${kind} on ${threads} thread${threads === 1 ? '' : 's'}`
    let memory: MemoryReading | null = null
    let failure: Error | null = null
    const stop = (error: Error) => {
      if (failure !== null) return
      failure = error
      child.kill('SIGKILL')
    }
    const timer = setTimeout(() => stop(new Error(`${label} ran past ${RUNNER_TIMEOUT_MS} ms`)), RUNNER_TIMEOUT_MS)
    child.on('error', error => stop(new Error(`${label} could not start: ${error.message}`)))
    child.stdin.on('error', () => undefined)

    const lines = createInterface({ input: child.stdout })
    lines.on('line', line => {
      if (line.length > MAX_RUNNER_STDOUT_LINE_BYTES) {
        stop(new Error(`${label} printed a line of ${line.length} characters on stdout`))
        return
      }
      if (line.trim() !== MEMORY_READY_LINE) {
        console.log(`  [${label}] ${line}`)
        return
      }
      if (memory !== null || child.pid === undefined) {
        stop(new Error(`${label} asked for a second memory reading`))
        return
      }
      readProcessMemory(child.pid).then(
        reading => {
          memory = reading
          child.stdin.end(`${MEMORY_MEASURED_LINE}\n`)
        },
        error => stop(error instanceof Error ? error : new Error(String(error))),
      )
    })

    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (failure !== null) {
        fail(failure)
        return
      }
      if (code !== 0) {
        fail(new Error(`${label} exited with ${code === null ? `signal ${signal}` : `code ${code}`}`))
        return
      }
      if (memory === null) {
        fail(new Error(`${label} finished without asking for a memory reading`))
        return
      }
      try {
        done({ output: readOutput(outputPath, spec, kind, threads), memory, outputPath })
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
  })
}
