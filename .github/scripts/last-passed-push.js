const { request } = require('./github-api.js')

const MAIN_BRANCH = 'main'
const PASSED_RUNS_PER_PAGE = 10
const COMMIT = /^[0-9a-f]{40}$/

function requirePassedPushOnMain(run, repository, workflowPath) {
  if (
    run?.event !== 'push' ||
    run.head_branch !== MAIN_BRANCH ||
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    run.path !== workflowPath ||
    run.repository?.full_name !== repository ||
    run.head_repository?.full_name !== repository ||
    typeof run.head_sha !== 'string' ||
    !COMMIT.test(run.head_sha)
  ) {
    throw new Error(`run ${run?.id} is listed as a passed push run on ${MAIN_BRANCH}, and its metadata disagrees`)
  }
}

async function lastPassedPushCommit(workflowPath) {
  const repository = process.env.GITHUB_REPOSITORY ?? ''
  if (repository === '') throw new Error('GITHUB_REPOSITORY is empty')
  if (!workflowPath.startsWith('.github/workflows/')) throw new Error(`${JSON.stringify(workflowPath)} is no workflow`)
  const workflow = workflowPath.slice('.github/workflows/'.length)
  const currentRun = process.env.GITHUB_RUN_ID ?? ''
  const body = await request(
    `/repos/${repository}/actions/workflows/${workflow}/runs?branch=${MAIN_BRANCH}&event=push&status=success&per_page=${PASSED_RUNS_PER_PAGE}`,
  )
  if (!Array.isArray(body?.workflow_runs)) throw new Error('the GitHub API returned an invalid workflow_runs page')
  const passed = body.workflow_runs
    .filter(run => String(run?.id) !== currentRun)
    .sort((left, right) => right.id - left.id)
  if (passed.length === 0) return null
  requirePassedPushOnMain(passed[0], repository, workflowPath)
  return passed[0].head_sha
}

module.exports = { lastPassedPushCommit }
