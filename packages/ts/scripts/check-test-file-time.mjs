import { readFileSync } from 'node:fs'
import { relative } from 'node:path'

const MAX_PULL_REQUEST_TEST_FILE_SECONDS = 15

const reportPath = process.argv[2]
if (reportPath === undefined) {
  console.error('Usage: node scripts/check-test-file-time.mjs <vitest-json-report>')
  process.exit(2)
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'))
const overLimit = report.testResults
  .map(result => ({ file: relative(process.cwd(), result.name), seconds: (result.endTime - result.startTime) / 1000 }))
  .filter(result => result.seconds > MAX_PULL_REQUEST_TEST_FILE_SECONDS)
  .sort((left, right) => right.seconds - left.seconds)

if (overLimit.length > 0) {
  for (const { file, seconds } of overLimit) {
    console.error(`${file} took ${seconds.toFixed(1)} s, over the ${MAX_PULL_REQUEST_TEST_FILE_SECONDS} s limit`)
  }
  console.error('Shorten each of these files, or add it to FILES_TESTED_AFTER_MERGE in vitest.pull-request.config.ts.')
  process.exit(1)
}

console.log(`${report.testResults.length} test files each took at most ${MAX_PULL_REQUEST_TEST_FILE_SECONDS} s`)
