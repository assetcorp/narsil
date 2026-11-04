import { createNarsil as createOnAppRuntime, type PhoneNarsil } from '@delali/narsil-react-native'
import { createNarsil as createOnEngineRuntime } from '@delali/narsil-react-native/worklets'
import { type HybridObject, NitroModules } from 'react-native-nitro-modules'
import { createWorkletRuntime, scheduleOnRN, scheduleOnRuntime } from 'react-native-worklets'
import { type CorpusDocument, corpus } from '../../expo/src/corpus'
import { startBusyProbe } from '../../expo/src/tasks/busy-probe'
import { SEARCH_SCHEMA } from '../../expo/src/tasks/search'
import { measureTransferSplit } from './transfer-split'

const CPU_ROUNDS = 40
const ALLOCATED_OBJECTS = 400_000
const KEPT_OBJECTS = 10_000
const TIMER_HOPS = 200
const MEASURED_DOCUMENTS = 10_000
const MEASURED_BATCH = 2_000
const COSTS_INDEX = 'costs'
const IMPORTED_INDEX = 'costs-imported'
const MISSING_INDEX = 'costs-never-created'
const OTHER_THREAD_BUSY_MS = 20_000
const SPLIT_DOCUMENTS = 20_000
const PARTITIONED_DOCUMENTS = 20_000
const COSTS_PARTITIONS = 8
const APP_DURABLE_DIRECTORY = 'costs-durable-app'
const ENGINE_DURABLE_DIRECTORY = 'costs-durable-engine'
const DISPATCHER_PROBE_GLOBAL = '__narsilDispatcherProbe'

type NativeHost = HybridObject<{ ios: 'c++'; android: 'c++' }>

interface RuntimeCosts {
  cpuMs: number
  allocationMs: number
  timerHopMs: number
  runtimeScheduler: boolean
}

interface EngineCosts {
  transferOnlyMs: number
  insertCallMs: number
  insertSettledMs: number
  importMs: number
  imported: number
}

function measureRuntime(done: (costs: RuntimeCosts) => void): void {
  'worklet'
  const words: string[] = []
  for (let index = 0; index < 5_000; index++) words.push(`w${index.toString(36)}x${(index * 7_919).toString(36)}`)
  const text = words.join(' ')
  let started = performance.now()
  const counts = new Map<string, number>()
  for (let round = 0; round < CPU_ROUNDS; round++) {
    for (const word of text.split(' ')) counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  const cpuMs = performance.now() - started
  started = performance.now()
  let kept: Array<{ index: number; label: string }> = []
  for (let index = 0; index < ALLOCATED_OBJECTS; index++) {
    kept.push({ index, label: `item ${index}` })
    if (kept.length > KEPT_OBJECTS) kept = []
  }
  const allocationMs = performance.now() - started
  const runtimeScheduler = typeof Reflect.get(globalThis, 'nativeRuntimeScheduler') === 'object'
  let hops = 0
  const hopsStarted = performance.now()
  function hop(): void {
    hops += 1
    if (hops < TIMER_HOPS) {
      setTimeout(hop, 0)
      return
    }
    done({ cpuMs, allocationMs, timerHopMs: (performance.now() - hopsStarted) / TIMER_HOPS, runtimeScheduler })
  }
  setTimeout(hop, 0)
}

function onAppRuntime(): Promise<RuntimeCosts> {
  return new Promise(resolve => {
    measureRuntime(resolve)
  })
}

function onWorkletRuntime(): Promise<RuntimeCosts> {
  const runtime = createWorkletRuntime({ name: 'narsil-runtime-costs' })
  return new Promise(resolve => {
    scheduleOnRuntime(runtime, () => {
      'worklet'
      measureRuntime(costs => {
        scheduleOnRN(resolve, costs)
      })
    })
  })
}

interface DispatcherProbe {
  installed: boolean
  dispatcherGlobal: boolean
  error: string | null
}

function dispatcherOnWorkletRuntime(): Promise<DispatcherProbe> {
  const host = NitroModules.box(NitroModules.createHybridObject<NativeHost>('NarsilHost'))
  const runtime = createWorkletRuntime({
    name: 'narsil-dispatcher-probe',
    initializer: () => {
      'worklet'
      try {
        const nativeHost = host.unbox()
        const install: unknown = Reflect.get(nativeHost, 'installWorkletDispatcher')
        const installed = typeof install === 'function' && Reflect.apply(install, nativeHost, []) === true
        Reflect.set(globalThis, DISPATCHER_PROBE_GLOBAL, installed)
      } catch (error) {
        Reflect.set(globalThis, DISPATCHER_PROBE_GLOBAL, String(error))
      }
    },
  })
  return new Promise(resolve => {
    scheduleOnRuntime(
      runtime,
      (done: (probe: DispatcherProbe) => void) => {
        'worklet'
        const outcome: unknown = Reflect.get(globalThis, DISPATCHER_PROBE_GLOBAL)
        scheduleOnRN(done, {
          installed: outcome === true,
          dispatcherGlobal: Reflect.has(globalThis, '__nitroDispatcher'),
          error: typeof outcome === 'string' ? outcome : null,
        })
      },
      resolve,
    )
  })
}

function keepAnotherThreadBusy(ms: number): Promise<number> {
  const runtime = createWorkletRuntime({ name: 'narsil-cpu-load' })
  return new Promise(resolve => {
    scheduleOnRuntime(
      runtime,
      (busyMs: number) => {
        'worklet'
        const endsAt = performance.now() + busyMs
        let spins = 0
        while (performance.now() < endsAt) spins += 1
        scheduleOnRN(resolve, spins)
      },
      ms,
    )
  })
}

async function measureTransferOnly(narsil: PhoneNarsil, documents: CorpusDocument[]): Promise<number> {
  const started = performance.now()
  for (let start = 0; start < documents.length; start += MEASURED_BATCH) {
    const refused = await narsil.insertBatch(MISSING_INDEX, documents.slice(start, start + MEASURED_BATCH)).then(
      () => false,
      () => true,
    )
    if (!refused) throw new Error(`The engine accepted a batch for ${MISSING_INDEX}, which no call created`)
  }
  return performance.now() - started
}

async function measureEngine(
  narsil: PhoneNarsil,
  documents: CorpusDocument[],
  file: string,
  maxPartitions?: number,
): Promise<EngineCosts> {
  try {
    for (const leftover of await narsil.listIndexes()) await narsil.dropIndex(leftover.name)
    const transferOnlyMs = await measureTransferOnly(narsil, documents)
    await narsil.createIndex(COSTS_INDEX, {
      schema: SEARCH_SCHEMA,
      language: 'english',
      ...(maxPartitions === undefined ? {} : { partitions: { maxPartitions } }),
    })
    let insertCallMs = 0
    const insertStarted = performance.now()
    for (let start = 0; start < documents.length; start += MEASURED_BATCH) {
      const calledAt = performance.now()
      const pending = narsil.insertBatch(COSTS_INDEX, documents.slice(start, start + MEASURED_BATCH))
      insertCallMs += performance.now() - calledAt
      const result = await pending
      if (result.failed.length > 0) throw new Error(`${result.failed.length} documents failed to insert`)
    }
    const insertSettledMs = performance.now() - insertStarted
    await narsil.exportDocumentsToFile(COSTS_INDEX, file)
    const importStarted = performance.now()
    const imported = await narsil.importDocumentExportFromFile(IMPORTED_INDEX, file)
    return {
      transferOnlyMs,
      insertCallMs,
      insertSettledMs,
      importMs: performance.now() - importStarted,
      imported: imported.imported,
    }
  } finally {
    await narsil.shutdown()
  }
}

export async function runRuntimeCostsTask(): Promise<Record<string, unknown>> {
  const appRuntime = await onAppRuntime()
  const workletRuntime = await onWorkletRuntime()
  const dispatcher = await dispatcherOnWorkletRuntime()
  const appEngine = await measureEngine(
    await createOnAppRuntime({ durability: null }),
    corpus(MEASURED_DOCUMENTS),
    'costs-app.ndjson',
  )
  const engineRuntime = await measureEngine(
    await createOnEngineRuntime({ durability: null }),
    corpus(MEASURED_DOCUMENTS),
    'costs-engine.ndjson',
  )
  const partitionedApp = await measureEngine(
    await createOnAppRuntime({ durability: null }),
    corpus(PARTITIONED_DOCUMENTS),
    'costs-app-partitioned.ndjson',
    COSTS_PARTITIONS,
  )
  const partitionedEngine = await measureEngine(
    await createOnEngineRuntime({ durability: null }),
    corpus(PARTITIONED_DOCUMENTS),
    'costs-engine-partitioned.ndjson',
    COSTS_PARTITIONS,
  )
  const durableApp = await measureEngine(
    await createOnAppRuntime({ durability: { directory: APP_DURABLE_DIRECTORY } }),
    corpus(PARTITIONED_DOCUMENTS),
    'costs-app-durable.ndjson',
    COSTS_PARTITIONS,
  )
  const durableEngine = await measureEngine(
    await createOnEngineRuntime({ durability: { directory: ENGINE_DURABLE_DIRECTORY } }),
    corpus(PARTITIONED_DOCUMENTS),
    'costs-engine-durable.ndjson',
    COSTS_PARTITIONS,
  )
  const transferSplit = await measureTransferSplit(corpus(SPLIT_DOCUMENTS)).catch((error: unknown) => ({
    failed: error instanceof Error ? error.message : String(error),
  }))
  const appEngineWhileAppBusy = await whileAppThreadBusy(async () =>
    measureEngine(await createOnAppRuntime({ durability: null }), corpus(MEASURED_DOCUMENTS), 'costs-app-busy.ndjson'),
  )
  const engineRuntimeWhileAppBusy = await whileAppThreadBusy(async () =>
    measureEngine(
      await createOnEngineRuntime({ durability: null }),
      corpus(MEASURED_DOCUMENTS),
      'costs-engine-busy.ndjson',
    ),
  )
  const otherThreadBusy = keepAnotherThreadBusy(OTHER_THREAD_BUSY_MS)
  const engineRuntimeWhileOtherThreadBusy = await measureEngine(
    await createOnEngineRuntime({ durability: null }),
    corpus(MEASURED_DOCUMENTS),
    'costs-engine-other-busy.ndjson',
  )
  const otherThreadSpins = await otherThreadBusy
  return {
    appRuntime,
    workletRuntime,
    dispatcher,
    appEngine,
    engineRuntime,
    partitionedApp,
    partitionedEngine,
    durableApp,
    durableEngine,
    transferSplit,
    appEngineWhileAppBusy,
    engineRuntimeWhileAppBusy,
    engineRuntimeWhileOtherThreadBusy,
    otherThreadSpins,
  }
}

async function whileAppThreadBusy<T>(work: () => Promise<T>): Promise<T> {
  const probe = startBusyProbe(performance.now())
  try {
    return await work()
  } finally {
    probe?.stop()
  }
}
