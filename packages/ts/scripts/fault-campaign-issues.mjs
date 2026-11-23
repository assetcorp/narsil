import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { GH_CALL_TIMEOUT_MS, MAX_OPEN_ISSUE_PAGES, MAX_SEED } from './fault-campaign/constants.mjs'
import { CAMPAIGN_CHECKS, OUTCOMES_FILE, readOutcomes } from './fault-campaign/outcomes.mjs'

const packageDirectory = fileURLToPath(new URL('..', import.meta.url))
const campaignDirectory = process.env.NARSIL_FAULT_CAMPAIGN_DIRECTORY ?? join(packageDirectory, 'fault-campaign')
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const SERVER_PATTERN = /^https:\/\/[A-Za-z0-9.-]+$/
const RUN_ID_PATTERN = /^\d+$/
const RUST_SLOTS = /^(\d(,\d)*)?$/
const ARTIFACT_URL_PATTERN =
  /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/\d+\/artifacts\/\d+$/
const TRIAGE_LABEL = 'needs-triage'
const CAMPAIGN_ISSUE_AUTHOR = 'github-actions[bot]'
const ISSUES_PER_PAGE = 100
const ARTIFACT_NAME = 'narsil-cluster-fault-failures'
const GH_OUTPUT_LIMIT_BYTES = 256 * 1024 * 1024
const CHECK_NAMES = new Set([
  ...CAMPAIGN_CHECKS,
  'the cluster heals after each fault',
  'every node starts',
  'every node stops cleanly',
  'the seed finishes within its time limit',
])

const { values } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    'open-issues': { type: 'string' },
  },
})
const dryRun = values['dry-run']
if (values['open-issues'] !== undefined && !dryRun) throw new Error('--open-issues only works with --dry-run')

function required(name, pattern) {
  const value = process.env[name]
  if (value === undefined || !pattern.test(value)) throw new Error(`${name} must match ${pattern}`)
  return value
}

const repository = required('GITHUB_REPOSITORY', REPOSITORY_PATTERN)
const runUrl = `${required('GITHUB_SERVER_URL', SERVER_PATTERN)}/${repository}/actions/runs/${required('GITHUB_RUN_ID', RUN_ID_PATTERN)}`
const artifactValue = process.env.NARSIL_FAULT_ARTIFACT_URL ?? ''
const artifactUrl = ARTIFACT_URL_PATTERN.test(artifactValue) ? artifactValue : null

function shown(argument) {
  return /^[A-Za-z0-9_./:=@-]+$/.test(argument) ? argument : `'${argument.replaceAll("'", `'\\''`)}'`
}

function gh(args, input) {
  if (dryRun) {
    console.log(`gh ${args.map(shown).join(' ')}`)
    if (input !== undefined) console.log(input.replace(/^/gm, '    '))
    return ''
  }
  const result = spawnSync('gh', args, {
    input,
    encoding: 'utf8',
    timeout: GH_CALL_TIMEOUT_MS,
    maxBuffer: GH_OUTPUT_LIMIT_BYTES,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`gh ${args.slice(0, 2).join(' ')} exited with ${result.status}: ${result.stderr.slice(0, 2_000)}`)
  }
  return result.stdout
}

function openIssuePage(page) {
  const output = spawnSync(
    'gh',
    [
      'api',
      `repos/${repository}/issues?state=open&sort=created&direction=asc&per_page=${ISSUES_PER_PAGE}&page=${page}`,
      '--jq',
      `[length, [.[] | select(.pull_request == null and .user.login == "${CAMPAIGN_ISSUE_AUTHOR}") | {number, body, user: {login: .user.login}}]]`,
    ],
    { encoding: 'utf8', timeout: GH_CALL_TIMEOUT_MS, maxBuffer: GH_OUTPUT_LIMIT_BYTES },
  )
  if (output.error !== undefined) throw output.error
  if (output.status !== 0) throw new Error(`gh api exited with ${output.status}: ${output.stderr.slice(0, 2_000)}`)
  const [count, issues] = JSON.parse(output.stdout)
  if (!Number.isSafeInteger(count) || !Array.isArray(issues))
    throw new Error('gh api returned a page of an unknown shape')
  return { count, issues }
}

function openIssues() {
  if (values['open-issues'] !== undefined) return JSON.parse(readFileSync(values['open-issues'], 'utf8'))
  const issues = []
  for (let page = 1; page <= MAX_OPEN_ISSUE_PAGES; page++) {
    const { count, issues: found } = openIssuePage(page)
    issues.push(...found)
    if (count < ISSUES_PER_PAGE) return issues
  }
  throw new Error(
    `The repository fills all ${MAX_OPEN_ISSUE_PAGES} pages of open issues that this script reads, so it stops before reading the rest`,
  )
}

function marker(seed) {
  return `<!-- fault-campaign-seed: ${seed} -->`
}

function issueFor(issues, seed) {
  const found = issues
    .filter(issue => Number.isSafeInteger(issue?.number) && typeof issue.body === 'string')
    .filter(issue => issue.user?.login === CAMPAIGN_ISSUE_AUTHOR)
    .filter(issue => issue.body.includes(marker(seed)))
    .sort((left, right) => left.number - right.number)
  return found[0]?.number ?? null
}

function validOutcome(outcome) {
  if (!Number.isSafeInteger(outcome?.seed) || outcome.seed < 0 || outcome.seed >= MAX_SEED) return false
  if (outcome.result === 'retired') return true
  if (outcome.result !== 'failed') return false
  if (outcome.carrier !== null && outcome.carrier !== 'tcp' && outcome.carrier !== 'grpc') return false
  if (outcome.tls !== null && typeof outcome.tls !== 'boolean') return false
  if (outcome.rustSlots !== undefined && outcome.rustSlots !== null && !RUST_SLOTS.test(outcome.rustSlots)) return false
  return Array.isArray(outcome.checks) && outcome.checks.every(check => CHECK_NAMES.has(check))
}

function carrierOf(outcome) {
  if (outcome.carrier === null) return 'not recorded in the log'
  const carrier = outcome.carrier === 'grpc' ? 'gRPC' : 'TCP'
  return outcome.tls === null ? carrier : `${carrier} ${outcome.tls ? 'over TLS' : 'over plain links'}`
}

function rustSlotsOf(outcome) {
  if (outcome.rustSlots === undefined || outcome.rustSlots === null) return 'not recorded in the log'
  return outcome.rustSlots === '' ? 'none' : outcome.rustSlots
}

function replayCommand(outcome) {
  const rust =
    typeof outcome.rustSlots === 'string' && outcome.rustSlots !== ''
      ? `NARSIL_FAULT_RUST_SLOTS=${outcome.rustSlots} NARSIL_RUST_CLUSTER_NODE=../rust-server/target/debug/examples/fault_node `
      : ''
  return `${rust}NARSIL_FAULT_CAMPAIGN=1 NARSIL_FAULT_SEED=${outcome.seed} pnpm exec vitest run src/__tests__/e2e/cluster-faults/seeded-faults.test.ts --silent=false --reporter=verbose`
}

function checksOf(outcome) {
  return outcome.checks.length === 0 ? 'none that the log names, so read the logs' : outcome.checks.join('; ')
}

function logsLine() {
  return artifactUrl === null
    ? `the \`${ARTIFACT_NAME}\` artifact of [the run](${runUrl})`
    : `[the \`${ARTIFACT_NAME}\` artifact](${artifactUrl})`
}

function newIssueBody(outcome) {
  return [
    marker(outcome.seed),
    'The nightly cluster fault campaign found a seed that fails.',
    '',
    `- Seed: ${outcome.seed}`,
    `- Carrier: ${carrierOf(outcome)}`,
    `- Slots that ran Rust nodes: ${rustSlotsOf(outcome)}`,
    `- Failed check: ${checksOf(outcome)}`,
    `- Run: ${runUrl}`,
    `- Logs: ${logsLine()}`,
    '',
    'Replay it from `packages/ts` after `pnpm nx run narsil-ts:build`, and after `cargo build --features cluster --example fault_node` in `packages/rust-server` when the seed ran Rust nodes:',
    '',
    '```sh',
    replayCommand(outcome),
    '```',
    '',
  ].join('\n')
}

function repeatBody(outcome) {
  return `Seed ${outcome.seed} failed again in ${runUrl}.\n\n- Failed check: ${checksOf(outcome)}\n- Logs: ${logsLine()}\n`
}

function report(outcome, issues) {
  const existing = issueFor(issues, outcome.seed)
  if (outcome.result === 'retired') {
    if (existing === null) return
    gh([
      'issue',
      'close',
      String(existing),
      '--repo',
      repository,
      '--comment',
      `Seed ${outcome.seed} passed three times in a row, the last in ${runUrl}, so the campaign retired it.`,
    ])
    return
  }
  if (existing !== null) {
    gh(['issue', 'comment', String(existing), '--repo', repository, '--body-file', '-'], repeatBody(outcome))
    return
  }
  gh(
    [
      'issue',
      'create',
      '--repo',
      repository,
      '--title',
      `Cluster fault campaign: seed ${outcome.seed} fails`,
      '--label',
      TRIAGE_LABEL,
      '--body-file',
      '-',
    ],
    newIssueBody(outcome),
  )
}

let outcomes
try {
  outcomes = readOutcomes(campaignDirectory)
} catch (error) {
  if (error?.code === 'ENOENT') {
    console.log(`The campaign wrote no ${OUTCOMES_FILE}, so no issue changes`)
    process.exit(0)
  }
  throw error
}
const latest = new Map()
for (const outcome of outcomes) {
  if (!validOutcome(outcome)) throw new Error(`${OUTCOMES_FILE} holds an outcome that this script refuses`)
  latest.set(outcome.seed, outcome)
}
const issues = openIssues()
const problems = []
for (const outcome of latest.values()) {
  try {
    report(outcome, issues)
  } catch (error) {
    problems.push(`seed ${outcome.seed}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
if (problems.length > 0) {
  console.error(problems.join('\n'))
  process.exitCode = 1
}
