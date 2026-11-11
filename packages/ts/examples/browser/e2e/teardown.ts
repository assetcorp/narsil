import { rm } from 'node:fs/promises'
import process from 'node:process'
import { E2E_DATA_DIR_ENV } from './settings'

export default async function teardown(): Promise<void> {
  const directory = process.env[E2E_DATA_DIR_ENV]
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
}
