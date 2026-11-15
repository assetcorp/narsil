const { appendFileSync } = require('node:fs')
const { SUITES, SUITES_BY_PACKAGE } = require('./release-suites.js')
const { createInputHasher, resolvedHead } = require('./suite-inputs.js')
const { createRunLookup } = require('./proven-suite-runs.js')

const SUCCESS_OR_SKIPPED = new Set(['success', 'skipped'])
const JOB_RESULTS_LINE = /^([a-z][a-z-]*)((?: [a-z_]+)+)$/

const REPOSITORY = process.env.GITHUB_REPOSITORY ?? ''

const outputKey = suiteName => suiteName.replaceAll('-', '_')

function writeOutput(key, value) {
  console.log(`${key}=${value}`)
  const target = process.env.GITHUB_OUTPUT
  if (target !== undefined && target !== '') appendFileSync(target, `${key}=${value}\n`)
}

function writeSummary(markdown) {
  const target = process.env.GITHUB_STEP_SUMMARY
  if (target !== undefined && target !== '') appendFileSync(target, markdown)
}

function createLookup(head) {
  return { inputHash: createInputHasher(), ...createRunLookup(head) }
}

function verdictOf(requiredJobs, jobs) {
  const conclusions = new Map()
  for (const job of jobs) {
    if (!requiredJobs.includes(job.name)) continue
    const known = conclusions.get(job.name) ?? []
    conclusions.set(job.name, [...known, job.status === 'completed' ? job.conclusion : job.status])
  }
  const reported = [...conclusions.values()].flat()
  if (reported.some(conclusion => !SUCCESS_OR_SKIPPED.has(conclusion))) return 'failed'
  const everyJobPassed = requiredJobs.every(name =>
    conclusions.get(name)?.every(conclusion => conclusion === 'success'),
  )
  return everyJobPassed ? 'passed' : 'not-run'
}

function newestFirst(left, right) {
  const byCreation = Date.parse(right.updated_at) - Date.parse(left.updated_at)
  return byCreation !== 0 ? byCreation : right.id - left.id
}

async function proofOf(suiteName, head, lookup) {
  const suite = SUITES[suiteName]
  const releaseHash = lookup.inputHash(suiteName, suite, head)
  const runs = (await Promise.all(suite.workflows.map(workflow => lookup.runsOf(workflow)))).flat().sort(newestFirst)
  const testsTheSameInputs = run => {
    try {
      return lookup.inputHash(suiteName, suite, run.head_sha) === releaseHash
    } catch {
      return false
    }
  }
  const matching = []
  for (const run of runs) {
    if (!testsTheSameInputs(run)) continue
    if (run.status !== 'completed') {
      return { proven: false, releaseHash, reason: `${run.html_url} is testing the same inputs and has not finished` }
    }
    matching.push(run)
  }
  for (const run of matching) {
    const verdict = verdictOf(suite.jobs, await lookup.jobsOf(run))
    if (verdict === 'not-run') continue
    if (verdict === 'failed') {
      return { proven: false, releaseHash, reason: `${run.html_url} failed this suite on the same inputs` }
    }
    if (run.conclusion !== 'success') continue
    await lookup.requireUnchanged(suite.workflows, run, testsTheSameInputs)
    return { proven: true, releaseHash, run }
  }
  return { proven: false, releaseHash, reason: 'no completed push run on main passed this suite on the same inputs' }
}

async function settledProofOf(suiteName, head, lookup) {
  try {
    return await proofOf(suiteName, head, lookup)
  } catch (error) {
    return {
      proven: false,
      releaseHash: null,
      reason: `the lookup failed: ${error instanceof Error ? error.message : error}`,
    }
  }
}

function summaryRow(suiteName, proof) {
  if (!proof.proven) return `| \`${suiteName}\` | runs in this release | ${proof.reason} |`
  const commit = proof.run.head_sha.slice(0, 9)
  return `| \`${suiteName}\` | reused | [run ${proof.run.id}](${proof.run.html_url}) passed it on \`${commit}\` |`
}

function parsedSuiteList(text) {
  const names = text
    .split(',')
    .map(name => name.trim())
    .filter(name => name.length > 0)
  const unknown = names.filter(name => SUITES[name] === undefined)
  if (unknown.length > 0) throw new Error(`no suite is called ${unknown.join(', ')}`)
  return [...new Set(names)]
}

async function lookUpPackage(packageName) {
  const suiteNames = SUITES_BY_PACKAGE[packageName]
  if (suiteNames === undefined) throw new Error(`no release package is called ${JSON.stringify(packageName)}`)
  const head = resolvedHead()
  const lookup = createLookup(head)
  const proofs = new Map()
  for (const suiteName of suiteNames) proofs.set(suiteName, await settledProofOf(suiteName, head, lookup))

  const rows = ['## Suites that main has already passed on these inputs', '', '| Suite | Result | Evidence |']
  rows.push('|---|---|---|', ...suiteNames.map(name => summaryRow(name, proofs.get(name))), '')
  console.log(rows.join('\n'))
  writeSummary(`${rows.join('\n')}\n`)
  const proven = suiteNames.filter(name => proofs.get(name).proven)
  for (const suiteName of Object.keys(SUITES)) writeOutput(outputKey(suiteName), String(proven.includes(suiteName)))
  writeOutput('proven', proven.join(','))
}

async function requireProofs(listText) {
  const suiteNames = parsedSuiteList(listText)
  if (suiteNames.length === 0) {
    console.log('This release reuses no suite from main, so every suite it needs passed in this run.')
    return
  }
  const head = resolvedHead()
  const lookup = createLookup(head)
  const missing = []
  for (const suiteName of suiteNames) {
    const proof = await settledProofOf(suiteName, head, lookup)
    console.log(summaryRow(suiteName, proof))
    if (!proof.proven) missing.push(suiteName)
  }
  if (missing.length > 0) {
    throw new Error(
      `main no longer proves ${missing.join(', ')} on these inputs, so this release publishes nothing; dispatch a fresh run, which runs those suites itself`,
    )
  }
}

function parsedJobResults(text) {
  const results = new Map()
  for (const line of text.split('\n').map(entry => entry.trim())) {
    if (line.length === 0) continue
    const match = JOB_RESULTS_LINE.exec(line)
    if (match === null) throw new Error(`SUITE_RESULTS holds a line that this script cannot read: ${line}`)
    if (SUITES[match[1]] === undefined) throw new Error(`SUITE_RESULTS reports ${match[1]}, which is no suite`)
    if (results.has(match[1])) throw new Error(`SUITE_RESULTS reports ${match[1]} twice`)
    results.set(match[1], match[2].trim().split(' '))
  }
  return results
}

async function gate(packageName) {
  const suiteNames = SUITES_BY_PACKAGE[packageName]
  if (suiteNames === undefined) throw new Error(`no release package is called ${JSON.stringify(packageName)}`)
  const results = parsedJobResults(process.env.SUITE_RESULTS ?? '')
  const reused = new Set(parsedSuiteList(process.env.REUSED_SUITES ?? ''))
  const failures = []
  const reusedSuites = []
  for (const suiteName of suiteNames) {
    const jobResults = results.get(suiteName)
    if (jobResults === undefined) {
      failures.push(`no job reports a result for ${suiteName}`)
    } else if (reused.has(suiteName)) {
      if (jobResults.every(result => SUCCESS_OR_SKIPPED.has(result))) reusedSuites.push(suiteName)
      else failures.push(`a job for ${suiteName} ended ${jobResults.join(', ')}`)
    } else if (!jobResults.every(result => result === 'success')) {
      failures.push(`${suiteName} had to pass in this run, and its jobs ended ${jobResults.join(', ')}`)
    } else {
      console.log(`| \`${suiteName}\` | passed in this run |`)
    }
  }
  if (failures.length > 0) throw new Error(`This release publishes nothing, because ${failures.join('; ')}`)
  await requireProofs(reusedSuites.join(','))
}

async function main() {
  if (REPOSITORY === '') throw new Error('GITHUB_REPOSITORY is empty')
  const [mode, value] = process.argv.slice(2)
  if (mode === '--package' && value !== undefined) return lookUpPackage(value)
  if (mode === '--require' && value !== undefined) return requireProofs(value)
  if (mode === '--gate' && value !== undefined) return gate(value)
  throw new Error(
    'Usage: proven-suites.js --package <release package> | --require <comma-separated suites> | --gate <release package>',
  )
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
