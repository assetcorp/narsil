import { spawn } from 'node:child_process'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import {
  MAX_RUNNER_OUTPUT_BYTES,
  MAX_RUNNER_STDOUT_BYTES,
  MAX_RUNNER_STDOUT_LINE_BYTES,
  RUNNER_TIMEOUT_MS,
} from '../constants'
import { MEMORY_MEASURED_LINE, MEMORY_READY_LINE, parseRunnerOutput, type RunnerOutput } from '../runner-output'
import { readManifest, type WorkloadKind, type WorkloadManifest } from '../workload/format'
import type { EngineSpec } from './catalog'
import { type MemoryReading, readProcessMemory } from './memory'

export interface RunnerRun {
  output: RunnerOutput
  memory: MemoryReading
  outputPath: string
}

function readOutput(
  path: string,
  spec: EngineSpec,
  kind: WorkloadKind,
  threads: number,
  manifest: WorkloadManifest,
): RunnerOutput {
  const file = lstatSync(path)
  if (!file.isFile()) throw new Error(`${spec.name} output must be a regular file`)
  const size = file.size
  if (size > MAX_RUNNER_OUTPUT_BYTES) {
    throw new Error(
      `${spec.name} wrote ${size} bytes to ${path}, above the ${MAX_RUNNER_OUTPUT_BYTES} that the driver reads`,
    )
  }
  return parseRunnerOutput(readFileSync(path, 'utf-8'), { engine: spec.name, workload: kind, threads, manifest })
}

export function runRunner(
  spec: EngineSpec,
  workload: string,
  kind: WorkloadKind,
  threads: number,
  outputPath: string,
  timeoutMs = RUNNER_TIMEOUT_MS,
): Promise<RunnerRun> {
  const manifest = readManifest(workload)
  if (existsSync(outputPath)) return Promise.reject(new Error(`runner output already exists: ${outputPath}`))
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > RUNNER_TIMEOUT_MS) {
    return Promise.reject(new Error('runner timeout must be a positive integer within the runner deadline'))
  }
  return new Promise((done, fail) => {
    const child = spawn(spec.command, spec.args(workload, kind, threads, outputPath), {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ['pipe', 'pipe', 'inherit'],
      detached: process.platform !== 'win32',
    })
    const label = `${spec.name} ${kind} on ${threads} thread${threads === 1 ? '' : 's'}`
    let memory: MemoryReading | null = null
    let failure: Error | null = null
    let requestedMemory = false
    const kill = () => {
      if (process.platform !== 'win32' && child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL')
        }
      } else child.kill('SIGKILL')
    }
    const stop = (error: Error) => {
      if (failure !== null) return
      failure = error
      kill()
    }
    const interrupted = () => stop(new Error(`${label} interrupted`))
    process.once('SIGINT', interrupted)
    process.once('SIGTERM', interrupted)
    process.once('exit', kill)
    const timer = setTimeout(() => stop(new Error(`${label} ran past ${timeoutMs} ms`)), timeoutMs)
    child.on('error', error => stop(new Error(`${label} could not start: ${error.message}`)))
    child.stdin.on('error', () => undefined)

    const onLine = (line: string) => {
      if (failure !== null) return
      if (line.trim() !== MEMORY_READY_LINE) {
        console.log(`  [${label}] ${line}`)
        return
      }
      if (requestedMemory || child.pid === undefined) {
        stop(new Error(`${label} asked for a second memory reading`))
        return
      }
      requestedMemory = true
      readProcessMemory(child.pid).then(
        reading => {
          if (failure !== null) return
          memory = reading
          child.stdin.end(`${MEMORY_MEASURED_LINE}\n`)
        },
        error => stop(error instanceof Error ? error : new Error(String(error))),
      )
    }
    let pending = Buffer.alloc(0)
    let stdoutBytes = 0
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > MAX_RUNNER_STDOUT_BYTES) return stop(new Error(`${label} exceeded its stdout budget`))
      pending = Buffer.concat([pending, chunk])
      let newline = pending.indexOf(10)
      while (newline !== -1) {
        if (newline > MAX_RUNNER_STDOUT_LINE_BYTES) return stop(new Error(`${label} exceeded its stdout line limit`))
        onLine(pending.subarray(0, newline).toString('utf-8'))
        pending = pending.subarray(newline + 1)
        newline = pending.indexOf(10)
      }
      if (pending.length > MAX_RUNNER_STDOUT_LINE_BYTES) stop(new Error(`${label} exceeded its stdout line limit`))
    })

    child.on('close', (code, signal) => {
      clearTimeout(timer)
      process.removeListener('SIGINT', interrupted)
      process.removeListener('SIGTERM', interrupted)
      process.removeListener('exit', kill)
      kill()
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
      if (pending.length > 0) return fail(new Error(`${label} finished with a truncated stdout line`))
      try {
        done({ output: readOutput(outputPath, spec, kind, threads, manifest), memory, outputPath })
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
  })
}
