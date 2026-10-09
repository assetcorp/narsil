const { existsSync, readdirSync, readFileSync } = require('node:fs')
const { join } = require('node:path')

const COMMENT_MARKER = '<!-- narsil-quality-checks -->'
const COMMENT_AUTHOR = 'github-actions[bot]'
const REPORT_FILE = 'report.json'
const PULL_REQUEST_FILE = 'pull-request'
const CHECK_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/
const LABEL_PATTERN = /^[A-Za-z0-9@][A-Za-z0-9@ .,()/-]{0,59}$/
const PULL_REQUEST_PATTERN = /^[1-9][0-9]{0,8}$/
const MAX_REPORTS = 20
const MAX_ROWS_PER_REPORT = 200
const COMMENTS_PER_PAGE = 100
const MAX_COMMENT_PAGES = 20
const API_TIMEOUT_MS = 15_000
const FLOATING_POINT_TOLERANCE = 1e-9

const isScore = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1

const requireLabel = (value, what) => {
  if (typeof value !== 'string' || !LABEL_PATTERN.test(value)) throw new Error(`a report holds an unusable ${what}`)
  return value
}

const parsePullRequestNumber = raw => {
  const text = raw.trim()
  if (!PULL_REQUEST_PATTERN.test(text))
    throw new Error('the pull request number in an artifact is not a positive integer')
  return Number(text)
}

const parseRow = raw => {
  if (typeof raw !== 'object' || raw === null) throw new Error('a report row is not an object')
  if (!isScore(raw.baseline) || !isScore(raw.measured)) throw new Error('a report holds a score outside 0 to 1')
  return {
    subject: requireLabel(raw.subject, 'subject'),
    metric: requireLabel(raw.metric, 'metric'),
    baseline: raw.baseline,
    measured: raw.measured,
    passed: raw.measured >= raw.baseline - FLOATING_POINT_TOLERANCE,
  }
}

const parseReport = raw => {
  if (typeof raw !== 'object' || raw === null) throw new Error('a report is not a JSON object')
  if (typeof raw.check !== 'string' || !CHECK_ID_PATTERN.test(raw.check))
    throw new Error('a report names no usable check')
  if (!Array.isArray(raw.rows) || raw.rows.length === 0 || raw.rows.length > MAX_ROWS_PER_REPORT) {
    throw new Error(`the ${raw.check} report holds the wrong number of rows`)
  }
  const rows = raw.rows.map(parseRow)
  if (new Set(rows.map(row => `${row.subject}\u0000${row.metric}`)).size !== rows.length) {
    throw new Error(`the ${raw.check} report repeats a subject and metric`)
  }
  return { check: raw.check, title: requireLabel(raw.title, 'title'), rows, passed: rows.every(row => row.passed) }
}

const artifactDirectories = root => {
  if (!existsSync(root)) return []
  const nested = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => join(root, entry.name))
  return [root, ...nested]
}

const readArtifacts = root => {
  const pullRequests = new Set()
  const reports = []
  let missingReports = 0
  for (const directory of artifactDirectories(root)) {
    const pullRequestPath = join(directory, PULL_REQUEST_FILE)
    if (!existsSync(pullRequestPath)) continue
    pullRequests.add(parsePullRequestNumber(readFileSync(pullRequestPath, 'utf8')))
    const reportPath = join(directory, REPORT_FILE)
    if (existsSync(reportPath)) reports.push(parseReport(JSON.parse(readFileSync(reportPath, 'utf8'))))
    else missingReports++
  }
  if (pullRequests.size > 1) throw new Error('the artifacts name more than one pull request')
  if (reports.length > MAX_REPORTS) throw new Error('the run uploaded more reports than this script renders')
  if (new Set(reports.map(report => report.check)).size !== reports.length) {
    throw new Error('the run uploaded two reports for the same check')
  }
  const [pullRequest] = pullRequests
  return { pullRequest, reports, missingReports }
}

const formatScore = value => value.toFixed(4)

const renderComment = (artifacts, runUrl) => {
  const lines = [COMMENT_MARKER, '### Quality checks', '']
  for (const report of artifacts.reports) {
    lines.push(
      `**${report.title}** ${report.passed ? 'matches or beats its recorded baseline.' : 'fell below its recorded baseline, so this check blocks the merge.'}`,
      '',
      '| Subject | Metric | Baseline | This pull request | Result |',
      '| --- | --- | ---: | ---: | --- |',
    )
    for (const row of report.rows) {
      const result = row.passed ? (row.measured > row.baseline ? 'higher' : 'equal') : '**lower**'
      lines.push(
        `| ${row.subject} | ${row.metric} | ${formatScore(row.baseline)} | ${formatScore(row.measured)} | ${result} |`,
      )
    }
    lines.push('')
  }
  if (artifacts.missingReports > 0) {
    lines.push(`${artifacts.missingReports} quality check(s) finished without a report.`, '')
  }
  lines.push(`The full output is in [the workflow run](${runUrl}).`)
  return lines.join('\n')
}

const requiredEnv = name => {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new Error(`${name} is not set`)
  return value
}

const githubRequest = async (method, path, body) => {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${requiredEnv('GITHUB_TOKEN')}`,
      'x-github-api-version': '2022-11-28',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`GitHub answered ${method} ${path} with status ${response.status}`)
  return response.status === 204 ? null : response.json()
}

const findExistingComment = async (repository, pullRequest) => {
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const comments = await githubRequest(
      'GET',
      `/repos/${repository}/issues/${pullRequest}/comments?per_page=${COMMENTS_PER_PAGE}&page=${page}`,
    )
    const found = comments.find(
      comment => comment.user?.login === COMMENT_AUTHOR && comment.body?.startsWith(COMMENT_MARKER),
    )
    if (found) return found
    if (comments.length < COMMENTS_PER_PAGE) return null
  }
  return null
}

const main = async () => {
  const repository = requiredEnv('GITHUB_REPOSITORY')
  const headSha = requiredEnv('HEAD_SHA')
  const runUrl = requiredEnv('RUN_URL')
  const artifacts = readArtifacts(requiredEnv('REPORT_DIR'))

  if (artifacts.pullRequest === undefined) {
    console.log('The run uploaded no quality check artifact, so there is nothing to comment on.')
    return
  }
  const { pullRequest } = artifacts

  const details = await githubRequest('GET', `/repos/${repository}/pulls/${pullRequest}`)
  if (details.head?.sha !== headSha) {
    console.log(`Pull request #${pullRequest} has moved past ${headSha}, so these reports are out of date.`)
    return
  }

  const passed = artifacts.missingReports === 0 && artifacts.reports.every(report => report.passed)
  const existing = await findExistingComment(repository, pullRequest)
  if (passed && existing === null) {
    console.log('Every quality check passed and no earlier comment needs updating.')
    return
  }

  const body = renderComment(artifacts, runUrl)
  if (existing === null) {
    await githubRequest('POST', `/repos/${repository}/issues/${pullRequest}/comments`, { body })
    console.log(`Commented on pull request #${pullRequest}.`)
    return
  }
  await githubRequest('PATCH', `/repos/${repository}/issues/comments/${existing.id}`, { body })
  console.log(`Updated the comment on pull request #${pullRequest}.`)
}

if (require.main === module) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

module.exports = { parsePullRequestNumber, parseReport, readArtifacts, renderComment }
