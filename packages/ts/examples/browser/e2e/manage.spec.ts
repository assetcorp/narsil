import { readFile } from 'node:fs/promises'
import { expect, type Locator, type Page, test } from '@playwright/test'
import { readPlaces } from '../../shared/e2e/places-oracle'
import { loadPlaces, searchFor } from './app'

const RESTORE_TIMEOUT_MS = 60_000

async function openManage(page: Page): Promise<void> {
  await page.goto('/inspector')
  await page.getByRole('button', { name: 'Manage', exact: true }).click()
}

function sectionStatus(page: Page, testId: string): Locator {
  return page.getByTestId(testId).locator('output')
}

function documentCount(page: Page, total: number): Locator {
  const noun = total === 1 ? 'document' : 'documents'
  return page.getByText(new RegExp(`of ${total.toLocaleString('en-US')} ${noun}( matching)?$`))
}

async function removePlaceNamed(page: Page, name: string): Promise<void> {
  await page.goto('/documents')
  await page.getByRole('button', { name: 'Filters' }).click()
  await page.getByRole('button', { name: 'Add condition' }).click()
  const rule = page.getByTestId('filter-rule').last()
  await rule.getByRole('combobox', { name: 'Field' }).click()
  await page.getByRole('option', { name: 'name', exact: true }).click()
  await rule.getByRole('combobox', { name: 'Test' }).click()
  await page.getByRole('option', { name: 'is', exact: true }).click()
  await rule.getByLabel('Value').fill(name)
  await expect(documentCount(page, 1)).toBeVisible()
  await page.getByRole('button', { name: 'View' }).click()
  await page.getByRole('button', { name: 'Edit document' }).click()
  await page.getByRole('button', { name: 'Delete document' }).click()
}

test.beforeEach(async ({ page }) => {
  await loadPlaces(page)
})

test('a two-way synonym finds every place that the other word finds', async ({ page }) => {
  const brazil = readPlaces().filter(place => place.country === 'Brazil').length

  await openManage(page)
  await page.getByLabel('Synonym rules').fill('pindorama, brazil')
  await page.getByRole('button', { name: 'Save synonyms' }).click()
  await expect(sectionStatus(page, 'manage-synonyms')).toContainText('1 synonym rule')

  await page.goto('/search')
  await searchFor(page, 'pindorama')
  await expect(page.getByText(`${brazil} results`, { exact: true })).toBeVisible()
})

test('an export lists every place, and a snapshot brings back a place removed after it', async ({ page }) => {
  const places = readPlaces()
  await openManage(page)

  const exportDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download export' }).click()
  const exportPath = await (await exportDownload).path()
  const lines = (await readFile(exportPath, 'utf-8')).split('\n').filter(line => line.length > 0)
  const exported = lines.slice(1).map(line => JSON.parse(line) as { id: string; name: string })
  expect(new Map(exported.map(entry => [entry.id, entry.name]))).toEqual(
    new Map(places.map(place => [place.id, place.name])),
  )

  const snapshotDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download snapshot' }).click()
  const snapshotPath = await (await snapshotDownload).path()

  await removePlaceNamed(page, 'Accra')
  await page.getByRole('button', { name: 'Clear all' }).click()
  await expect(documentCount(page, places.length - 1)).toBeVisible()

  await openManage(page)
  await page.getByLabel('Snapshot file to restore').setInputFiles(snapshotPath)
  await expect(sectionStatus(page, 'manage-backups')).toContainText('The index holds what', {
    timeout: RESTORE_TIMEOUT_MS,
  })
  await page.goto('/documents')
  await expect(documentCount(page, places.length)).toBeVisible()
})

test('rebalancing spreads the places across the partition count that the tester chose', async ({ page }) => {
  const places = readPlaces()
  await openManage(page)
  await page.getByLabel('Partition count').fill('3')
  await page.getByRole('button', { name: 'Rebalance' }).click()
  await expect(sectionStatus(page, 'manage-partitions')).toContainText('3 partitions')

  await page.getByRole('button', { name: 'Stats', exact: true }).click()
  await expect(page.getByText('Partitions', { exact: true }).first()).toBeVisible()
  await page.goto('/documents')
  await expect(documentCount(page, places.length)).toBeVisible()
  await page.goto('/search')
  await searchFor(page, 'brazil')
  await expect(page.getByText(`${places.filter(place => place.country === 'Brazil').length} results`)).toBeVisible()
})
