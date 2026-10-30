import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

const MAX_PRESUBMIT_TEST_FILE_SECONDS = 15
const MIN_POSTSUBMIT_TEST_FILE_SECONDS = 10
const TESTS_ROOT = 'src/__tests__'
const LIST_FILE = 'postsubmit-test-files.json'
const RULE = `${LIST_FILE} takes a file only when it stays over ${MAX_PRESUBMIT_TEST_FILE_SECONDS} s on continuous integration after you shorten it, and when another test file in its directory runs in presubmit.`

const { suitesWithTheirOwnTarget, postsubmit } = JSON.parse(readFileSync(LIST_FILE, 'utf8'))
const postsubmitFiles = new Set(postsubmit)

function hasOwnTarget(file) {
  return suitesWithTheirOwnTarget.some(suite => (suite.endsWith('/') ? file.startsWith(suite) : file === suite))
}

function fail(problems) {
  for (const problem of problems) console.error(problem)
  console.error(RULE)
  process.exit(1)
}

function checkLists() {
  const testFiles = readdirSync(TESTS_ROOT, { recursive: true })
    .map(file => String(file))
    .filter(file => file.endsWith('.test.ts'))
  const known = new Set(testFiles)
  const presubmitDirectories = new Set(
    testFiles.filter(file => !postsubmitFiles.has(file) && !hasOwnTarget(file)).map(file => dirname(file)),
  )
  const problems = []
  for (const file of postsubmit) {
    if (!known.has(file)) problems.push(`${file} is in ${LIST_FILE}, but no such test file exists`)
    else if (!presubmitDirectories.has(dirname(file))) {
      problems.push(`${dirname(file)} has no test file in presubmit, so ${file} has to stay out of ${LIST_FILE}`)
    }
  }
  for (const suite of suitesWithTheirOwnTarget) {
    if (!statSync(join(TESTS_ROOT, suite), { throwIfNoEntry: false })) problems.push(`${suite} does not exist`)
  }
  if (problems.length > 0) fail(problems)
  console.log(`${postsubmit.length} postsubmit files each have a presubmit test file in their directory`)
}

function timedFiles(reportPath) {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  return report.testResults
    .filter(result => result.assertionResults.some(assertion => assertion.status === 'passed'))
    .map(result => ({
      file: relative(TESTS_ROOT, relative(process.cwd(), result.name)),
      seconds: (result.endTime - result.startTime) / 1000,
    }))
    .sort((left, right) => right.seconds - left.seconds)
}

function checkPresubmitTimes(reportPath) {
  const files = timedFiles(reportPath)
  const overLimit = files.filter(({ seconds }) => seconds > MAX_PRESUBMIT_TEST_FILE_SECONDS)
  if (overLimit.length > 0) {
    fail(
      overLimit.map(
        ({ file, seconds }) =>
          `${file} took ${seconds.toFixed(1)} s, over the ${MAX_PRESUBMIT_TEST_FILE_SECONDS} s presubmit limit`,
      ),
    )
  }
  console.log(`${files.length} test files each took at most ${MAX_PRESUBMIT_TEST_FILE_SECONDS} s`)
}

function checkPostsubmitTimes(reportPath) {
  const listed = timedFiles(reportPath).filter(({ file }) => postsubmitFiles.has(file))
  const underLimit = listed.filter(({ seconds }) => seconds < MIN_POSTSUBMIT_TEST_FILE_SECONDS)
  if (underLimit.length > 0) {
    fail(
      underLimit.map(
        ({ file, seconds }) =>
          `${file} took ${seconds.toFixed(1)} s, under the ${MIN_POSTSUBMIT_TEST_FILE_SECONDS} s floor, so move it back to presubmit`,
      ),
    )
  }
  console.log(`${listed.length} postsubmit files each took at least ${MIN_POSTSUBMIT_TEST_FILE_SECONDS} s`)
}

const [mode, reportPath] = process.argv.slice(2)
if (mode === 'lists') checkLists()
else if (mode === 'presubmit' && reportPath !== undefined) checkPresubmitTimes(reportPath)
else if (mode === 'postsubmit' && reportPath !== undefined) checkPostsubmitTimes(reportPath)
else {
  console.error('Usage: node scripts/check-postsubmit-list.mjs lists | presubmit <report> | postsubmit <report>')
  process.exit(2)
}
