import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { ORACLE_PYTHON, ORACLE_ROOT, SUITE_ROOT } from '../paths'
import { workloadSettings } from '../workload/settings'
import { writeWorkload } from '../workload/write'

it('accepts tied cutoffs and empty queries while rejecting a lower scoring replacement', async () => {
  const scratch = mkdtempSync(resolve(tmpdir(), 'narsil-ranking-ties-'))
  let staging = ''
  try {
    const workload = resolve(scratch, 'workload')
    const documents = Array.from({ length: 24 }, (_, index) => ({
      id: `document-${index}`,
      title: 'lantern',
      body: 'harbour',
    }))
    documents.push({ id: 'lower-score', title: 'lantern harbour harbour harbour harbour', body: 'harbour' })
    documents[0].id = 'i'.repeat(512)
    await writeWorkload(workload, {
      keyword: { dataset: 'ties', documents, queries: ['lantern', '', '   ', 'the'] },
      vector: {
        dataset: 'ties',
        model: 'identical vectors',
        dimension: 2,
        documents,
        documentVectors: Float32Array.from(documents.flatMap(() => [1, 0])),
        queries: [{ id: 'query', text: 'lantern' }],
        queryVectors: new Float32Array([1, 0]),
      },
      settings: workloadSettings('small'),
    })
    const driver = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        resolve(SUITE_ROOT, 'src/run.ts'),
        '--workload',
        workload,
        '--threads',
        '1,8',
        '--repetitions',
        '1',
        '--keep-outputs',
        '--output-root',
        scratch,
      ],
      { cwd: SUITE_ROOT, env: { ...process.env, BENCH_PROFILE: 'smoke' }, encoding: 'utf-8', timeout: 120_000 },
    )
    staging = /Runner outputs go to (\S+)/.exec(driver.stdout)?.[1] ?? ''
    expect(`${driver.stdout}\n${driver.stderr}`).toContain('Every answer matched the oracle')
    expect(driver.status).toBe(0)
    const file = JSON.parse(readFileSync(resolve(staging, 'rep-1-rust-vector-1.json'), 'utf-8'))
    file.verification.vector[0].hits = file.verification.vectorDeep[0].hits.slice(-10)
    const output = resolve(scratch, 'alternative-tied-hits.json')
    writeFileSync(output, JSON.stringify(file))
    const oracle = spawnSync(
      ORACLE_PYTHON,
      [
        '-m',
        'engine_languages_oracle',
        '--workload',
        workload,
        '--truth',
        resolve(scratch, 'truth.json'),
        '--verdict',
        resolve(scratch, 'verdict.json'),
        output,
      ],
      { cwd: ORACLE_ROOT, encoding: 'utf-8', timeout: 30_000 },
    )
    expect(oracle.stderr).toBe('')
    expect(oracle.status).toBe(0)
    const keyword = JSON.parse(readFileSync(resolve(staging, 'rep-1-rust-keyword-1.json'), 'utf-8'))
    keyword.verification.keyword[0].hits[9][0] = 'lower-score'
    writeFileSync(output, JSON.stringify(keyword))
    const rejected = spawnSync(
      ORACLE_PYTHON,
      [
        '-m',
        'engine_languages_oracle',
        '--workload',
        workload,
        '--truth',
        resolve(scratch, 'truth.json'),
        '--verdict',
        resolve(scratch, 'verdict.json'),
        output,
      ],
      { cwd: ORACLE_ROOT, encoding: 'utf-8', timeout: 30_000 },
    )
    expect(rejected.status).toBe(1)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
    if (staging) rmSync(staging, { recursive: true, force: true })
  }
})
