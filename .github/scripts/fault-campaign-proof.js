const { request } = require('./github-api.js')

const CAMPAIGN_WORKFLOW = 'cluster-fault-campaign.yml'
const CAMPAIGN_WORKFLOW_PATH = `.github/workflows/${CAMPAIGN_WORKFLOW}`
const MAIN_BRANCH = 'main'
const NEWEST_CAMPAIGN_RUNS = 20
const RUN_STATES = ['completed', 'in_progress', 'queued', 'requested', 'waiting', 'pending', 'action_required']
const COMMIT = /^[0-9a-f]{40}$/
const PACKAGES_THAT_THE_CAMPAIGN_GATES = new Set([
  '@delali/narsil',
  'all',
  'delali-narsil-server',
  'delali-narsil-cluster',
])

function campaignRunOnMain(run, repository) {
  if (
    !Number.isSafeInteger(run?.id) ||
    run.id <= 0 ||
    typeof run.head_sha !== 'string' ||
    !COMMIT.test(run.head_sha) ||
    !RUN_STATES.includes(run.status) ||
    (run.status === 'completed' && typeof run.conclusion !== 'string') ||
    !Number.isFinite(Date.parse(run.created_at)) ||
    typeof run.html_url !== 'string' ||
    typeof run.head_branch !== 'string' ||
    typeof run.path !== 'string' ||
    typeof run.repository?.full_name !== 'string' ||
    typeof run.head_repository?.full_name !== 'string'
  ) {
    throw new Error(`campaign run ${run?.id} holds incomplete metadata`)
  }
  return (
    run.head_branch === MAIN_BRANCH &&
    run.path === CAMPAIGN_WORKFLOW_PATH &&
    run.repository.full_name === repository &&
    run.head_repository.full_name === repository
  )
}

function newestFirst(left, right) {
  const byCreation = Date.parse(right.created_at) - Date.parse(left.created_at)
  return byCreation !== 0 ? byCreation : right.id - left.id
}

async function newestCampaignRun(repository) {
  const body = await request(
    `/repos/${repository}/actions/workflows/${CAMPAIGN_WORKFLOW}/runs?branch=${MAIN_BRANCH}&per_page=${NEWEST_CAMPAIGN_RUNS}`,
  )
  if (
    !Array.isArray(body?.workflow_runs) ||
    !Number.isSafeInteger(body.total_count) ||
    body.total_count < 0 ||
    body.workflow_runs.length !== Math.min(body.total_count, NEWEST_CAMPAIGN_RUNS)
  ) {
    throw new Error('the GitHub API returned an invalid page of campaign runs')
  }
  const ids = new Set()
  for (const run of body.workflow_runs) {
    if (ids.has(run?.id)) throw new Error('the GitHub API repeated a campaign run')
    ids.add(run?.id)
  }
  const onMain = body.workflow_runs.filter(run => campaignRunOnMain(run, repository)).sort(newestFirst)
  return onMain[0] ?? null
}

async function requireCampaignPassed(packageName) {
  if (!PACKAGES_THAT_THE_CAMPAIGN_GATES.has(packageName)) return
  const repository = process.env.GITHUB_REPOSITORY ?? ''
  if (repository === '') throw new Error('GITHUB_REPOSITORY is empty')
  const run = await newestCampaignRun(repository)
  if (run === null) {
    throw new Error(
      `This release publishes nothing, because the cluster fault campaign has no run on ${MAIN_BRANCH}; dispatch ${CAMPAIGN_WORKFLOW} on ${MAIN_BRANCH} and release once it passes`,
    )
  }
  if (run.status !== 'completed') {
    throw new Error(
      `This release publishes nothing, because the newest cluster fault campaign on ${MAIN_BRANCH}, ${run.html_url}, has not finished; release once it passes`,
    )
  }
  if (run.conclusion !== 'success') {
    throw new Error(
      `This release publishes nothing, because the newest cluster fault campaign on ${MAIN_BRANCH}, ${run.html_url}, ended ${run.conclusion}; fix the seeds that it reports and release once a campaign on ${MAIN_BRANCH} passes`,
    )
  }
  console.log(
    `| cluster fault campaign | passed | [run ${run.id}](${run.html_url}) on \`${run.head_sha.slice(0, 9)}\` |`,
  )
}

module.exports = { requireCampaignPassed }
