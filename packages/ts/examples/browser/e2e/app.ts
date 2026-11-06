import { expect, type Locator, type Page } from '@playwright/test'

const DATASET_LOAD_TIMEOUT_MS = 60_000

export function placesCard(page: Page): Locator {
  return page.locator('[data-slot="card"]').filter({ hasText: 'World Places' })
}

export async function loadPlaces(page: Page): Promise<void> {
  await page.goto('/')
  const card = placesCard(page)
  await card.getByRole('button', { name: 'Configure' }).click()
  await page.getByRole('button', { name: 'Load dataset' }).click()
  await expect(card.getByRole('button', { name: 'View documents' })).toBeVisible({
    timeout: DATASET_LOAD_TIMEOUT_MS,
  })
}

export async function chooseOption(page: Page, label: string, option: string): Promise<void> {
  await page.getByRole('combobox', { name: label }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}

export function numberIn(text: string | null): number {
  return Number((text ?? '').replace(/,/g, '').trim())
}

export async function resultIds(page: Page): Promise<string[]> {
  const ids = await page
    .getByTestId('result-card')
    .evaluateAll(cards => cards.map(card => card.getAttribute('data-doc-id')))
  return ids.filter((id): id is string => id !== null)
}

export async function searchFor(page: Page, term: string): Promise<void> {
  await page.getByPlaceholder('Search documents...').fill(term)
}
