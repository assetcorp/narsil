const { isAncestor, requireCommit } = require('./suite-inputs.js')

const MAIN_BRANCH = 'main'
const PER_PAGE = 100
const MAX_RUN_PAGES = 10
const MAX_JOB_PAGES = 5
const REQUEST_TIMEOUT_MS = 30_000
const REQUEST_ATTEMPTS = 3
const RETRY_DELAY_MS = 2_000
const API = process.env.GITHUB_API_URL ?? 'https://api.github.com'
const REPOSITORY = process.env.GITHUB_REPOSITORY ?? ''

async function request(path) {
  const token = process.env.GITHUB_TOKEN ?? ''
  if (token === '') throw new Error('GITHUB_TOKEN is empty')
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  }
  for (let attempt = 1; ; attempt += 1) {
    let response = null
    let failure = null
    try {
      response = await fetch(`${API}${path}`, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    if (response?.ok) return response.json()
    const retryable = response === null || response.status >= 500 || response.status === 429
    if (!retryable || attempt >= REQUEST_ATTEMPTS) {
      throw new Error(`the GitHub API answered ${response?.status ?? failure} to ${path}`)
    }
    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * attempt))
  }
}

async function pagesOf(path, field, limit) {
  const entries = []
  let total = null
  const ids = new Set()
  for (let page = 1; page <= limit; page += 1) {
    const separator = path.includes('?') ? '&' : '?'
    const body = await request(`${path}${separator}per_page=${PER_PAGE}&page=${page}`)
    if (!Array.isArray(body?.[field]) || !Number.isSafeInteger(body.total_count) || body.total_count < 0) {
      throw new Error(`the GitHub API returned an invalid ${field} page`)
    }
    if (total !== null && total !== body.total_count) throw new Error(`${field} changed during pagination`)
    total = body.total_count
    if (total > limit * PER_PAGE) throw new Error(`${field} exceeds the lookup limit`)
    for (const entry of body[field]) {
      if (!Number.isSafeInteger(entry?.id) || entry.id <= 0 || ids.has(entry.id)) {
        throw new Error(`${field} holds an invalid or repeated ID`)
      }
      ids.add(entry.id)
      entries.push(entry)
    }
    if (entries.length > total) throw new Error(`${field} lists more entries than it counts`)
    if (entries.length === total) return entries
    if (body[field].length !== PER_PAGE) throw new Error(`${field} lists fewer entries than it counts`)
  }
  throw new Error(`${field} exceeds the lookup limit`)
}

function trustedRun(run, workflow) {
  requireCommit(run.head_sha)
  if (
    !Number.isSafeInteger(run.run_attempt) ||
    run.run_attempt <= 0 ||
    !['completed', 'in_progress', 'queued', 'requested', 'waiting', 'pending'].includes(run.status) ||
    !Number.isFinite(Date.parse(run.updated_at)) ||
    !Number.isFinite(Date.parse(run.created_at)) ||
    typeof run.event !== 'string' ||
    typeof run.head_branch !== 'string' ||
    typeof run.path !== 'string' ||
    (run.status === 'completed' && typeof run.conclusion !== 'string') ||
    typeof run.repository?.full_name !== 'string' ||
    typeof run.head_repository?.full_name !== 'string'
  ) {
    throw new Error(`run ${run.id} holds incomplete metadata`)
  }
  return (
    run.event === 'push' &&
    run.head_branch === MAIN_BRANCH &&
    run.path === `.github/workflows/${workflow}` &&
    run.repository.full_name === REPOSITORY &&
    run.head_repository.full_name === REPOSITORY
  )
}

function runState(run) {
  return JSON.stringify([
    run.id,
    run.head_sha,
    run.run_attempt,
    run.status,
    run.conclusion,
    run.updated_at,
    run.path,
    run.event,
    run.head_branch,
    run.repository?.full_name,
    run.head_repository?.full_name,
  ])
}

function createRunLookup(head) {
  const runsByWorkflow = new Map()
  const jobsByAttempt = new Map()

  async function listRuns(workflow) {
    const path = `/repos/${REPOSITORY}/actions/workflows/${workflow}/runs?branch=${MAIN_BRANCH}&event=push`
    const runs = await pagesOf(path, 'workflow_runs', MAX_RUN_PAGES)
    return runs.filter(run => trustedRun(run, workflow))
  }

  async function runsOf(workflow) {
    if (!runsByWorkflow.has(workflow)) runsByWorkflow.set(workflow, listRuns(workflow))
    return (await runsByWorkflow.get(workflow)).filter(run => isAncestor(run.head_sha, head))
  }

  async function jobsOf(run) {
    const current = await request(`/repos/${REPOSITORY}/actions/runs/${run.id}`)
    if (runState(current) !== runState(run)) throw new Error(`run ${run.id} changed before its jobs were read`)
    const key = `${run.id}/${run.run_attempt}`
    if (!jobsByAttempt.has(key)) {
      const path = `/repos/${REPOSITORY}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`
      jobsByAttempt.set(key, pagesOf(path, 'jobs', MAX_JOB_PAGES))
    }
    const jobs = await jobsByAttempt.get(key)
    if (
      jobs.some(
        job =>
          job.run_id !== run.id ||
          job.run_attempt !== run.run_attempt ||
          job.head_sha !== run.head_sha ||
          typeof job.name !== 'string' ||
          typeof job.status !== 'string',
      )
    ) {
      throw new Error(`run ${run.id} lists jobs from another attempt or commit`)
    }
    return jobs
  }

  async function requireUnchanged(workflows, run) {
    for (const workflow of workflows) {
      const before = (await runsByWorkflow.get(workflow)).map(runState).sort()
      const after = (await listRuns(workflow)).map(runState).sort()
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error(`${workflow} changed during the lookup`)
    }
    const current = await request(`/repos/${REPOSITORY}/actions/runs/${run.id}`)
    if (runState(current) !== runState(run)) throw new Error(`run ${run.id} changed after its jobs were read`)
  }

  return { runsOf, jobsOf, requireUnchanged }
}

module.exports = { createRunLookup }
