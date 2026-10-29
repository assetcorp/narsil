import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  expectFilteredAnswers,
  type Hit,
  INDEX,
  nearCentre,
  papersFrom,
  queries,
  selectivities,
  shelvesConfig,
  vectorQuery,
} from './filtered-vectors/library'

const CHILD_SCRIPT = fileURLToPath(new URL('./child-restore-during-build-dist.mjs', import.meta.url))
const built = existsSync(new URL('../../../dist/index.mjs', import.meta.url))

const PAPERS = 2_000
const BATCH_SIZE = 200
const ROUNDS = 6
const REEMBEDDED_EACH_ROUND = 200
const CHILD_DEADLINE_MS = 120_000
const TEST_TIMEOUT_MS = 180_000

let directory = ''

afterEach(async () => {
  if (directory !== '') await rm(directory, { recursive: true, force: true })
  directory = ''
})

interface ChildOutcome {
  answers: Hit[][]
}

function runChild(scenarioPath: string): Promise<ChildOutcome> {
  const env: NodeJS.ProcessEnv = { ...process.env, NARSIL_SCENARIO: scenarioPath, NARSIL_SEARCH_BACKEND: 'wasm' }
  delete env.NARSIL_REQUIRE_NATIVE_CORE
  const child = spawn(process.execPath, [CHILD_SCRIPT], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      child.kill('SIGKILL')
      const rounds = stdout.split('\n').filter(line => line.startsWith('ROUND ')).length
      reject(
        new Error(
          `the engine stopped answering for ${CHILD_DEADLINE_MS / 1000} s after ${rounds} of ${ROUNDS} restores during a graph build: ${stderr.slice(-2_000)}`,
        ),
      )
    }, CHILD_DEADLINE_MS)
    child.on('error', err => {
      clearTimeout(deadline)
      reject(err)
    })
    child.on('exit', code => {
      clearTimeout(deadline)
      const line = stdout.split('\n').find(candidate => candidate.startsWith('ANSWERS '))
      if (code !== 0 || line === undefined) {
        reject(new Error(`the child exited with ${code}: ${stderr.slice(-2_000)}`))
        return
      }
      resolve({ answers: JSON.parse(line.slice('ANSWERS '.length)) as Hit[][] })
    })
  })
}

describe.skipIf(!built)('a restore that withdraws worker copies while the search pool places vectors', () => {
  it(
    'finishes every restore and answers from the restored papers',
    async () => {
      const papers = papersFrom(0, PAPERS)
      const rounds = Array.from({ length: ROUNDS }, () =>
        papers.slice(0, REEMBEDDED_EACH_ROUND).map(paper => ({ ...paper, embedding: nearCentre() })),
      )
      const questions = selectivities.flatMap(({ filters }) =>
        queries.map(query => ({ filters, query, params: vectorQuery(query, filters) })),
      )
      directory = await mkdtemp(join(tmpdir(), 'narsil-restore-during-build-'))
      const scenarioPath = join(directory, 'scenario.json')
      await writeFile(
        scenarioPath,
        JSON.stringify({ index: INDEX, config: shelvesConfig, papers, batchSize: BATCH_SIZE, rounds, questions }),
      )

      const { answers } = await runChild(scenarioPath)

      expect(answers).toHaveLength(questions.length)
      const answerOf = new Map(questions.map((question, i) => [question, answers[i]]))
      const library = new Map(papers.map(paper => [paper.id, paper]))
      await expectFilteredAnswers(
        async (query, filters) => {
          const question = questions.find(candidate => candidate.query === query && candidate.filters === filters)
          return question === undefined ? [] : (answerOf.get(question) ?? [])
        },
        library,
        'after the last restore',
      )
    },
    TEST_TIMEOUT_MS,
  )
})
