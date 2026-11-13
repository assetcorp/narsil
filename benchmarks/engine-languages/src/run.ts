import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import { basename, resolve } from 'node:path'
import { writeJsonAtomicSync, writeTextAtomicSync } from 'benchmarks/src/runner/atomic-write'
import { prepareRunFolder } from 'benchmarks/src/runner/run-paths'
import { type MeasuredRun, summarise } from './aggregate'
import { parseRunOptions, type RunOptions } from './cli'
import { cCompiler, type EngineSpec, prepareEngines } from './engines/catalog'
import { runRunner } from './engines/spawn'
import { ensureOracle, type OutputVerdict, runOracle, type Verdict } from './oracle'
import { BUILD_ROOT, STAGING_ROOT, SUITE_ROOT } from './paths'
import {
  type LanguagesResults,
  type MachineDescription,
  REPORT_FILE,
  RESULTS_FILE,
  RESULTS_FORMAT,
  renderReport,
  VERDICT_FILE,
} from './report'
import { type EngineName, PHASES_BY_WORKLOAD } from './runner-output'
import { MANIFEST_FILE, WORKLOAD_KINDS } from './workload/format'
import { type ResolvedWorkload, resolveWorkload } from './workload/resolve'

const GIBIBYTE_BYTES = 1_073_741_824

interface StagedRun extends MeasuredRun {
  outputPath: string
}

function sourceOfRun(run: StagedRun): string {
  return basename(run.outputPath)
}

function rotated<T>(items: readonly T[], by: number): T[] {
  const shift = items.length === 0 ? 0 : by % items.length
  return [...items.slice(shift), ...items.slice(0, shift)]
}

function describeMachine(): MachineDescription {
  const label = process.env.BENCH_MACHINE_LABEL?.trim()
  return {
    os: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    cpu: os.cpus()[0]?.model.trim() ?? 'unknown',
    logicalCpus: os.availableParallelism(),
    totalMemory: `${Math.round(os.totalmem() / GIBIBYTE_BYTES)} GiB`,
    ...(label ? { machineLabel: label } : {}),
  }
}

function truthPath(workload: ResolvedWorkload): string {
  const manifest = readFileSync(resolve(workload.directory, MANIFEST_FILE))
  const directory = resolve(BUILD_ROOT, 'oracle-truth')
  mkdirSync(directory, { recursive: true })
  return resolve(directory, `${createHash('sha256').update(manifest).digest('hex')}.json`)
}

function requireAgreement(runs: readonly StagedRun[]): void {
  for (const run of runs) {
    for (const name of PHASES_BY_WORKLOAD[run.output.workload]) {
      const mismatches = run.output.phases[name]?.mismatches ?? 0
      if (mismatches > 0) {
        throw new Error(
          `${basename(run.outputPath)} answered ${mismatches} measured ${name} queries differently from its checked answer`,
        )
      }
    }
  }
}

async function measureRepetition(
  repetition: number,
  options: RunOptions,
  engines: ReadonlyMap<EngineName, EngineSpec>,
  workload: ResolvedWorkload,
  staging: string,
): Promise<{ runs: StagedRun[]; order: EngineName[] }> {
  const order = rotated(options.engines, repetition)
  const runs: StagedRun[] = []
  for (const threads of options.threadCounts) {
    for (const kind of WORKLOAD_KINDS) {
      for (const name of order) {
        const spec = engines.get(name)
        if (spec === undefined) throw new Error(`the ${name} runner was not built`)
        const outputPath = resolve(staging, `rep-${repetition + 1}-${name}-${kind}-${threads}.json`)
        console.log(`Repetition ${repetition + 1} of ${options.repetitions}: ${name} ${kind} on ${threads} threads`)
        const run = await runRunner(spec, workload.directory, kind, threads, outputPath)
        runs.push({ repetition, output: run.output, memory: run.memory, outputPath })
      }
    }
  }
  return { runs, order }
}

function writeRun(
  options: RunOptions,
  engines: ReadonlyMap<EngineName, EngineSpec>,
  compiler: string,
  workload: ResolvedWorkload,
  runs: readonly StagedRun[],
  order: EngineName[][],
  verdict: Verdict,
): string {
  const verdicts = new Map<string, OutputVerdict>(verdict.outputs.map(output => [output.source, output]))
  const measurements = summarise(runs, verdicts, sourceOfRun)
  const now = new Date()
  const prepared = prepareRunFolder({ packageRoot: options.outputRoot ?? SUITE_ROOT, profile: options.profile, now })
  const results: LanguagesResults = {
    format: RESULTS_FORMAT,
    runId: prepared.runId,
    createdAt: prepared.manifest.createdAt,
    git: { branch: prepared.manifest.git.branch, commit: prepared.manifest.git.commit },
    machine: describeMachine(),
    engines: Object.fromEntries([...engines].map(([name, spec]) => [name, spec.identity])),
    cCompiler: compiler,
    workload: {
      keyword: workload.manifest.keyword,
      vector: workload.manifest.vector,
      settings: workload.manifest.settings,
      sha256: workload.manifest.sha256,
    },
    repetitions: options.repetitions,
    threadCounts: options.threadCounts,
    engineOrder: order,
    measurements,
    crossEngine: verdict.crossEngine,
    oracle: verdict.oracle,
  }
  writeJsonAtomicSync(resolve(prepared.runDir, RESULTS_FILE), results)
  writeJsonAtomicSync(resolve(prepared.runDir, VERDICT_FILE), verdict)
  writeTextAtomicSync(resolve(prepared.runDir, REPORT_FILE), `${renderReport(results)}\n`)
  return prepared.runDir
}

async function main(): Promise<void> {
  const options = parseRunOptions(process.argv.slice(2))
  const workload = await resolveWorkload(options.workload, options.size)
  await ensureOracle()
  const engines = await prepareEngines(options.engines)
  const compiler = await cCompiler()
  const truth = truthPath(workload)

  mkdirSync(STAGING_ROOT, { recursive: true })
  const staging = mkdtempSync(resolve(STAGING_ROOT, 'run-'))
  console.log(`Runner outputs go to ${staging}`)
  const runs: StagedRun[] = []
  const order: EngineName[][] = []
  for (let repetition = 0; repetition < options.repetitions; repetition++) {
    const measured = await measureRepetition(repetition, options, engines, workload, staging)
    requireAgreement(measured.runs)
    await runOracle(
      workload.directory,
      truth,
      resolve(staging, `rep-${repetition + 1}-${VERDICT_FILE}`),
      measured.runs.map(run => run.outputPath),
    )
    runs.push(...measured.runs)
    order.push(measured.order)
  }
  const verdict = await runOracle(
    workload.directory,
    truth,
    resolve(staging, VERDICT_FILE),
    runs.map(run => run.outputPath),
  )
  const runDirectory = writeRun(options, engines, compiler, workload, runs, order, verdict)
  if (!options.keepOutputs) rmSync(staging, { recursive: true, force: true })
  console.log(`Every answer matched the oracle. The run is in ${runDirectory}`)
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
