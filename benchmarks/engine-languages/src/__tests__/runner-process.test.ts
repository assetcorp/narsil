import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MAX_RUNNER_OUTPUT_BYTES, MAX_RUNNER_STDOUT_LINE_BYTES } from '../constants'
import type { EngineSpec } from '../engines/catalog'
import { runRunner } from '../engines/spawn'
import { workloadSettings } from '../workload/settings'

const DESCENDANT_EXIT_DEADLINE_MS = 5_000
const DESCENDANT_POLL_MS = 20
const EXITED_STATES = ['Z', 'X', 'gone']

function processState(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf-8').split(' ')[2] ?? 'unreadable'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'gone'
    throw error
  }
}

let scratch = ''
let sequence = 0
const settings = workloadSettings('small')
const valid = {
  engine: 'typescript',
  workload: 'keyword',
  threads: 8,
  load: { documents: 1, insertNs: 100, optimizeNs: 0, readyNs: 0 },
  phases: {
    keyword: {
      queries: 1,
      warmupPasses: settings.warmupPasses,
      passes: settings.measuredPasses.keyword,
      threads: 8,
      wallNs: 1000,
      latencyNs: [10, 20, 30, 40, 50],
      mismatches: 0,
    },
  },
}

beforeAll(() => {
  scratch = mkdtempSync(resolve(tmpdir(), 'narsil-runner-process-'))
  const files = [
    'keyword-documents.jsonl',
    'keyword-queries.jsonl',
    'vector-documents.jsonl',
    'vector-documents.f32',
    'vector-queries.jsonl',
    'vector-queries.f32',
  ]
  writeFileSync(
    resolve(scratch, 'manifest.json'),
    JSON.stringify({
      format: 1,
      keyword: { dataset: 'fixture', documents: 1, queries: 1 },
      vector: { dataset: 'fixture', model: 'fixture', dimension: 1, documents: 1, queries: 1 },
      settings,
      sha256: Object.fromEntries(files.map(file => [file, '0'.repeat(64)])),
    }),
  )
})
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function execute(code: string, timeout = 3000) {
  const output = resolve(scratch, `output-${sequence++}.json`)
  const spec: EngineSpec = {
    name: 'typescript',
    command: process.execPath,
    cwd: scratch,
    env: process.env,
    identity: { package: 'protocol-fixture', version: '1', runtime: 'node', build: 'test' },
    args: () => ['-e', code, output],
  }
  return runRunner(spec, scratch, 'keyword', 8, output, timeout)
}

function writeOutput(text: string): string {
  return String.raw`process.stdout.write('memory-ready\n'); process.stdin.once('data', () => {
    require('node:fs').writeFileSync(process.argv[1], ${JSON.stringify(text)}); process.exit(0);
  });`
}

describe('the runner process protocol', () => {
  it('accepts a complete measurement with the declared work and a memory handshake', async () => {
    const result = await execute(writeOutput(JSON.stringify(valid)))
    expect(result.output.phases.keyword?.latencyNs).toEqual([10, 20, 30, 40, 50])
    expect(result.memory.residentBytes).toBeGreaterThan(0)
  })

  it.each([
    [
      'fewer passes',
      (value: typeof valid) => {
        value.phases.keyword.passes = 1
        value.phases.keyword.latencyNs = [10]
      },
    ],
    [
      'missing warmup',
      (value: typeof valid) => {
        value.phases.keyword.warmupPasses = 0
      },
    ],
    [
      'another query count',
      (value: typeof valid) => {
        value.phases.keyword.queries = 0
        value.phases.keyword.latencyNs = []
      },
    ],
    [
      'missing documents',
      (value: typeof valid) => {
        value.load.documents = 0
      },
    ],
    [
      'zero insertion time',
      (value: typeof valid) => {
        value.load.insertNs = 0
      },
    ],
    [
      'zero latency',
      (value: typeof valid) => {
        value.phases.keyword.latencyNs[0] = 0
      },
    ],
    [
      'impossible latency',
      (value: typeof valid) => {
        value.phases.keyword.latencyNs[0] = 1001
      },
    ],
    [
      'corrupted measured answer',
      (value: typeof valid) => {
        value.phases.keyword.mismatches = 1
      },
    ],
  ])('refuses %s', async (_, change) => {
    const value = structuredClone(valid)
    change(value)
    await expect(execute(writeOutput(JSON.stringify(value)))).rejects.toThrow('runner output:')
  })

  it.each(['', '{', 'null', '[]', '{"engine":'])('refuses truncated or malformed JSON %j', async text => {
    await expect(execute(writeOutput(text))).rejects.toThrow()
  })

  it('kills a runner that ignores termination signals and never finishes', async () => {
    await expect(execute("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)", 100)).rejects.toThrow(
      'ran past 100 ms',
    )
  })

  it('kills descendants that retain the stdout pipe after their parent exits', async () => {
    const pidPath = resolve(scratch, 'descendant.pid')
    const code = `const child = require('node:child_process').spawn(process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'], {stdio: ['ignore', 1, 2]});
      require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(child.pid)); process.exit(0);`
    await expect(execute(code, 500)).rejects.toThrow('ran past 500 ms')
    const pid = Number(readFileSync(pidPath, 'utf-8'))
    const deadline = Date.now() + DESCENDANT_EXIT_DEADLINE_MS
    let state = processState(pid)
    while (!EXITED_STATES.includes(state) && Date.now() < deadline) {
      await new Promise(resolveAfter => setTimeout(resolveAfter, DESCENDANT_POLL_MS))
      state = processState(pid)
    }
    expect(EXITED_STATES).toContain(state)
  })

  it('refuses a runner that crashes', async () => {
    await expect(execute('process.exit(7)')).rejects.toThrow('code 7')
  })

  it('refuses a runner that requests memory twice before the first reading completes', async () => {
    await expect(
      execute(String.raw`process.stdout.write('memory-ready\nmemory-ready\n'); setInterval(() => {}, 1000)`),
    ).rejects.toThrow('second memory reading')
  })

  it('bounds stdout before a newline arrives', async () => {
    await expect(
      execute(`process.stdout.write('x'.repeat(${MAX_RUNNER_STDOUT_LINE_BYTES + 1})); setInterval(() => {}, 1000)`),
    ).rejects.toThrow('stdout line limit')
  })

  it('counts stdout bytes rather than characters', async () => {
    await expect(
      execute(
        String.raw`process.stdout.write('é'.repeat(${MAX_RUNNER_STDOUT_LINE_BYTES / 2 + 1}) + '\n'); setInterval(() => {}, 1000)`,
      ),
    ).rejects.toThrow('stdout line limit')
  })

  it('refuses an oversized output before reading it', async () => {
    const code = String.raw`process.stdout.write('memory-ready\n'); process.stdin.once('data', () => {
      const fs = require('node:fs'); const fd = fs.openSync(process.argv[1], 'w');
      fs.ftruncateSync(fd, ${MAX_RUNNER_OUTPUT_BYTES + 1}); fs.closeSync(fd); process.exit(0);
    });`
    await expect(execute(code)).rejects.toThrow('above the')
  })

  it('refuses a device masquerading as an output file', async () => {
    const code = String.raw`process.stdout.write('memory-ready\n'); process.stdin.once('data', () => {
      require('node:fs').symlinkSync('/dev/zero', process.argv[1]); process.exit(0);
    });`
    await expect(execute(code)).rejects.toThrow('regular file')
  })
})
