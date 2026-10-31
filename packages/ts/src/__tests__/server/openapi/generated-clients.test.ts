import { execFile } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from '../helpers'
import { publishedFilePath } from './contract-checker'

const run = promisify(execFile)

const GENERATOR_IMAGE =
  'openapitools/openapi-generator-cli:v7.26.0@sha256:a304ddf1e2e5f24f68fa3153568d6174cea4959d09aa8e3db6d526fd0782326d'
const PYTHON_IMAGE = 'python:3.12-slim@sha256:aa943ce411423c7582288f18707ff66eddcbaeb510502d747a72aeb34f30d159'
const GO_IMAGE = 'golang:1.24-alpine@sha256:8bee1901f1e530bfb4a7850aa7a479d17ae3a18beb6e09064ed54cfd245b7191'
const CONTAINER_TIMEOUT_MS = 300_000
const CONTAINER_OUTPUT_BYTES = 16 * 1024 * 1024
const WORK_MOUNT = '/work'
const INSERTED_ID = 'guide-1'
const INSERTED_TITLE = 'A field guide to mountain trails'
const SEARCH_TERM = 'mountain'
const EXPECTED_HIT = `HIT ${INSERTED_ID} ${INSERTED_TITLE}`

const PYTHON_PROGRAM = `
import os
import narsil_client
from narsil_client.models import HttpCreateIndexBody, InsertBody, HttpQueryParams

configuration = narsil_client.Configuration(host=os.environ["NARSIL_URL"])
with narsil_client.ApiClient(configuration) as client:
    indexes = narsil_client.IndexesApi(client)
    documents = narsil_client.DocumentsApi(client)
    search = narsil_client.SearchApi(client)
    indexes.create_index(HttpCreateIndexBody.from_dict({
        "name": "python_guides",
        "config": {"schema": {"title": "string"}},
    }))
    documents.insert("python_guides", InsertBody.from_dict({
        "document": {"title": ${JSON.stringify(INSERTED_TITLE)}},
        "id": ${JSON.stringify(INSERTED_ID)},
    }))
    documents.wait_for_writes("python_guides")
    result = search.query("python_guides", HttpQueryParams.from_dict({"term": ${JSON.stringify(SEARCH_TERM)}}))
    hit = result.hits[0]
    print("HIT", hit.id, hit.document.additional_properties["title"])
`

const GO_PROGRAM = `package main

import (
	"context"
	"fmt"
	"os"

	narsil "narsil/client"
)

func must(err error) {
	if err != nil {
		panic(err)
	}
}

func main() {
	configuration := narsil.NewConfiguration()
	configuration.Servers = narsil.ServerConfigurations{{URL: os.Getenv("NARSIL_URL")}}
	client := narsil.NewAPIClient(configuration)
	ctx := context.Background()

	fieldType := "string"
	schema := map[string]narsil.SchemaDefinitionValue{
		"title": {FieldType: &narsil.FieldType{String: &fieldType}},
	}
	createBody := narsil.NewHttpCreateIndexBody("go_guides", *narsil.NewHttpIndexBody(schema))
	_, _, err := client.IndexesAPI.CreateIndex(ctx).HttpCreateIndexBody(*createBody).Execute()
	must(err)

	id := ${JSON.stringify(INSERTED_ID)}
	document := narsil.AnyDocument{AdditionalProperties: map[string]interface{}{"title": ${JSON.stringify(INSERTED_TITLE)}}}
	insertBody := narsil.NewInsertBody(document)
	insertBody.SetId(id)
	_, _, err = client.DocumentsAPI.Insert(ctx, "go_guides").InsertBody(*insertBody).Execute()
	must(err)
	_, _, err = client.DocumentsAPI.WaitForWrites(ctx, "go_guides").Execute()
	must(err)

	queryBody := narsil.NewHttpQueryParams()
	queryBody.SetTerm(${JSON.stringify(SEARCH_TERM)})
	result, _, err := client.SearchAPI.Query(ctx, "go_guides").HttpQueryParams(*queryBody).Execute()
	must(err)
	hit := result.Hits[0]
	fmt.Println("HIT", hit.Id, hit.Document.AdditionalProperties["title"])
}
`

async function docker(args: string[]): Promise<string> {
  const { stdout } = await run('docker', args, { timeout: CONTAINER_TIMEOUT_MS, maxBuffer: CONTAINER_OUTPUT_BYTES })
  return stdout
}

function ownerFlags(): string[] {
  return ['--user', `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`]
}

async function generate(work: string, generator: string, output: string, properties: string): Promise<void> {
  await docker([
    'run',
    '--rm',
    ...ownerFlags(),
    '--network=none',
    '--volume',
    `${work}:${WORK_MOUNT}`,
    GENERATOR_IMAGE,
    'generate',
    '--input-spec',
    `${WORK_MOUNT}/openapi.json`,
    '--generator-name',
    generator,
    '--output',
    `${WORK_MOUNT}/${output}`,
    '--additional-properties',
    properties,
  ])
}

const enabled = process.env.NARSIL_TEST_OPENAPI_CLIENTS === '1'

describe.runIf(enabled)('clients generated from the published OpenAPI file', () => {
  let server: TestServer
  let work: string
  let hostUrl: string

  beforeAll(async () => {
    server = await startTestServer(undefined, { workers: { enabled: false } })
    hostUrl = `http://127.0.0.1:${server.server.listeningPort}`
    work = await mkdtemp(join(tmpdir(), 'narsil-openapi-clients-'))
    await chmod(work, 0o777)
    await writeFile(join(work, 'openapi.json'), await readFile(publishedFilePath()))
  }, CONTAINER_TIMEOUT_MS)

  afterAll(async () => {
    await server.stop()
    await rm(work, { recursive: true, force: true })
  })

  it(
    'inserts a document and finds it with a generated Python client',
    async () => {
      await generate(work, 'python', 'python', 'packageName=narsil_client,generateSourceCodeOnly=false')
      await writeFile(join(work, 'python', 'program.py'), PYTHON_PROGRAM)
      const stdout = await docker([
        'run',
        '--rm',
        ...ownerFlags(),
        '--network=host',
        '--env',
        `NARSIL_URL=${hostUrl}`,
        '--env',
        'HOME=/tmp',
        '--env',
        'PYTHONPATH=/tmp/site',
        '--volume',
        `${work}/python:${WORK_MOUNT}`,
        '--workdir',
        WORK_MOUNT,
        PYTHON_IMAGE,
        'sh',
        '-c',
        'pip install --quiet --disable-pip-version-check --target /tmp/site . && python program.py',
      ])
      expect(stdout.trim().split('\n').pop()).toBe(EXPECTED_HIT)
    },
    CONTAINER_TIMEOUT_MS,
  )

  it(
    'inserts a document and finds it with a generated Go client',
    async () => {
      await generate(work, 'go', 'go/client', 'packageName=narsil,isGoSubmodule=true,withGoMod=true')
      await writeFile(join(work, 'go', 'go.mod'), 'module narsil\n\ngo 1.24\n')
      await writeFile(join(work, 'go', 'main.go'), GO_PROGRAM)
      const stdout = await docker([
        'run',
        '--rm',
        ...ownerFlags(),
        '--network=host',
        '--env',
        `NARSIL_URL=${hostUrl}`,
        '--env',
        'GOFLAGS=-mod=mod',
        '--env',
        'HOME=/tmp',
        '--env',
        'GOPATH=/tmp/go',
        '--env',
        'GOCACHE=/tmp/go-cache',
        '--volume',
        `${work}/go:${WORK_MOUNT}`,
        '--workdir',
        WORK_MOUNT,
        GO_IMAGE,
        'sh',
        '-c',
        'sed -i "s#^module .*#module narsil/client#" client/go.mod && echo "require narsil/client v0.0.0" >> go.mod && echo "replace narsil/client => ./client" >> go.mod && go run .',
      ])
      expect(stdout.trim().split('\n').pop()).toBe(EXPECTED_HIT)
    },
    CONTAINER_TIMEOUT_MS,
  )
})
