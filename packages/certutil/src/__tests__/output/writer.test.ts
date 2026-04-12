import { randomBytes } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureDirectory, fileExists, writeOutputFile } from '../../output/writer'

function tempDir(): string {
  return join(tmpdir(), `certutil-writer-test-${randomBytes(8).toString('hex')}`)
}

describe('fileExists', () => {
  let dir: string

  beforeEach(() => {
    dir = tempDir()
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns false for a path that does not exist', async () => {
    const result = await fileExists(join(dir, 'nope.txt'))
    expect(result).toBe(false)
  })

  it('returns true for a path that exists', async () => {
    await ensureDirectory(dir)
    const filePath = join(dir, 'exists.txt')
    await writeOutputFile(filePath, 'content', true)
    const result = await fileExists(filePath)
    expect(result).toBe(true)
  })
})

describe('ensureDirectory', () => {
  let dir: string

  beforeEach(() => {
    dir = tempDir()
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('creates nested directories', async () => {
    const nested = join(dir, 'a', 'b', 'c')
    await ensureDirectory(nested)
    const exists = await fileExists(nested)
    expect(exists).toBe(true)
  })

  it('does not throw when directory already exists', async () => {
    await ensureDirectory(dir)
    await expect(ensureDirectory(dir)).resolves.toBeUndefined()
  })
})

describe('writeOutputFile', () => {
  let dir: string

  beforeEach(() => {
    dir = tempDir()
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('creates file and parent directories', async () => {
    const filePath = join(dir, 'sub', 'deep', 'test.pem')
    await writeOutputFile(filePath, 'pem-content', false)
    const content = await readFile(filePath, 'utf-8')
    expect(content).toBe('pem-content')
  })

  it('throws when file exists and overwrite is false', async () => {
    const filePath = join(dir, 'existing.pem')
    await writeOutputFile(filePath, 'first', true)

    await expect(writeOutputFile(filePath, 'second', false)).rejects.toThrow('File already exists')
    await expect(writeOutputFile(filePath, 'second', false)).rejects.toThrow('--force')
  })

  it('overwrites when overwrite is true', async () => {
    const filePath = join(dir, 'overwrite.pem')
    await writeOutputFile(filePath, 'original', true)
    await writeOutputFile(filePath, 'updated', true)
    const content = await readFile(filePath, 'utf-8')
    expect(content).toBe('updated')
  })

  it('writes empty content without error', async () => {
    const filePath = join(dir, 'empty.pem')
    await writeOutputFile(filePath, '', false)
    const content = await readFile(filePath, 'utf-8')
    expect(content).toBe('')
  })
})
