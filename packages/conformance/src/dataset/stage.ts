import { appendFile, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { sha256Of, verifiedArtifact } from './artifact'
import { ARTIFACT_MANIFEST, DATASET_ID, SOURCE_DATASET, SOURCE_LICENSE, VECTOR_MODEL } from './constants'
import { PIN_PATH, RELEASE_TAG, RELEASE_URL, readPin } from './pin'

const GITHUB_OUTPUT_ENV = 'GITHUB_OUTPUT'

function releaseNotes(digest: string, files: Awaited<ReturnType<typeof verifiedArtifact>>): string {
  return [
    `The dataset of the Narsil conformance suite under \`packages/conformance\`: the titles and summaries of the first US bills in [${SOURCE_DATASET}](https://huggingface.co/datasets/${SOURCE_DATASET}) (${SOURCE_LICENSE}), with their \`${VECTOR_MODEL}\` vectors and the fixed queries.`,
    '',
    `The suite's fetch command downloads \`${ARTIFACT_MANIFEST}\` first, compares its SHA-256 with \`packages/conformance/dataset-pin.json\`, and then checks every file against the digest that the manifest lists.`,
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| Dataset | \`${DATASET_ID}\` |`,
    `| Manifest SHA-256 | \`${digest}\` |`,
    '',
    '| Asset | Bytes | SHA-256 |',
    '| --- | ---: | --- |',
    ...files.map(file => `| \`${file.asset}\` | ${file.bytes.toLocaleString('en-GB')} | \`${file.sha256}\` |`),
    '',
    '```json',
    JSON.stringify({ url: RELEASE_URL, sha256: digest }, null, 2),
    '```',
    '',
  ].join('\n')
}

async function stage(artifactDirectory: string, stageRoot: string): Promise<void> {
  const digest = sha256Of(await readFile(join(artifactDirectory, ARTIFACT_MANIFEST)))
  const files = await verifiedArtifact(artifactDirectory, digest)
  const stageDirectory = join(stageRoot, RELEASE_TAG)
  await rm(stageDirectory, { recursive: true, force: true })
  await mkdir(stageDirectory, { recursive: true })
  await copyFile(join(artifactDirectory, ARTIFACT_MANIFEST), join(stageDirectory, ARTIFACT_MANIFEST))
  for (const file of files) await copyFile(join(artifactDirectory, file.path), join(stageDirectory, file.asset))
  const notes = join(stageRoot, `${RELEASE_TAG}.md`)
  await writeFile(notes, releaseNotes(digest, files))
  const pin = await readPin()
  const outputs = {
    tag: RELEASE_TAG,
    title: `Conformance dataset artifact: ${DATASET_ID}`,
    stage: stageDirectory,
    notes,
    digest,
    pinned: pin?.sha256 ?? '',
    pin_path: PIN_PATH,
  }
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`)
  console.log(lines.join('\n'))
  const githubOutput = process.env[GITHUB_OUTPUT_ENV]
  if (githubOutput !== undefined) await appendFile(githubOutput, `${lines.join('\n')}\n`)
}

const [artifactDirectory, stageRoot] = process.argv.slice(2)
if (artifactDirectory === undefined || stageRoot === undefined) {
  console.error('usage: dataset:stage <artifact directory> <stage root>')
  process.exit(2)
}
await stage(resolve(artifactDirectory), resolve(stageRoot))
