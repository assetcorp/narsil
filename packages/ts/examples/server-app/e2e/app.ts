import { createNarsilClient } from '@delali/narsil/client'
import { expect, type Locator, type Page } from '@playwright/test'
import { E2E_ORIGIN } from './settings'

export const PLACES_INDEX = 'places'
export const DATASET_LOAD_TIMEOUT_MS = 300_000

export const server = createNarsilClient({ url: `${E2E_ORIGIN}/api/narsil` })

function placesCard(page: Page): Locator {
  return page.locator('[data-slot="card"]').filter({ hasText: 'World Places' })
}

export async function loadPlaces(page: Page): Promise<void> {
  await page.goto('/')
  const card = placesCard(page)
  const loaded = (await server.listIndexes()).some(index => index.name === PLACES_INDEX)
  if (!loaded) {
    await card.getByRole('button', { name: 'Configure' }).click()
    await page.getByRole('button', { name: 'Load dataset' }).click()
  }
  await expect(card.getByRole('button', { name: 'View documents' })).toBeVisible({ timeout: DATASET_LOAD_TIMEOUT_MS })
}

export function countLine(page: Page, total: number, filtered = false): Locator {
  const noun = total === 1 ? 'document' : 'documents'
  return page.getByText(new RegExp(`of ${total.toLocaleString('en-US')} ${noun}${filtered ? ' matching' : ''}$`))
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
