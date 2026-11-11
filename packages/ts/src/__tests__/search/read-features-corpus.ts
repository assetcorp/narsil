import type { AnyDocument } from '../../types/schema'
import type { QueryParams } from '../../types/search'

export const READ_FEATURES_SCHEMA = { title: 'string', category: 'string', price: 'number' } as const

const CATEGORIES = ['tools', 'kitchen', 'garden'] as const
const PRICE_STRIDE = 37
const PLAIN_EVERY = 4
const KEPT_PER_GROUP = 2
const PAGE_SIZE = 10
const SEARCHED_WORD = 'widget'

export interface ShopItem extends AnyDocument {
  id: string
  title: string
  category: string
  price: number
}

export function shopItems(count: number): ShopItem[] {
  return Array.from({ length: count }, (_, at) => ({
    id: `item-${String(at).padStart(4, '0')}`,
    title: at % PLAIN_EVERY === PLAIN_EVERY - 1 ? 'plain item' : `${SEARCHED_WORD} item`,
    category: CATEGORIES[at % CATEGORIES.length],
    price: (at * PRICE_STRIDE) % count,
  }))
}

function matchingByPrice(items: readonly ShopItem[]): ShopItem[] {
  return items
    .filter(item => item.title.split(' ').includes(SEARCHED_WORD))
    .sort((left, right) => left.price - right.price)
}

export function pinnedOutsider(items: readonly ShopItem[]): ShopItem {
  const outsider = items.find(item => !item.title.split(' ').includes(SEARCHED_WORD))
  if (outsider === undefined) throw new Error('The corpus holds no item outside the searched word')
  return outsider
}

export const groupedQuery: QueryParams = {
  term: SEARCHED_WORD,
  sort: { price: 'asc' },
  group: { fields: ['category'], maxPerGroup: KEPT_PER_GROUP },
}

export function pinnedQuery(items: readonly ShopItem[]): QueryParams {
  return {
    term: SEARCHED_WORD,
    sort: { price: 'asc' },
    limit: PAGE_SIZE,
    pinned: [{ docId: pinnedOutsider(items).id, position: 0 }],
  }
}

export const facetedQuery: QueryParams = {
  term: SEARCHED_WORD,
  limit: PAGE_SIZE,
  facets: { category: {} },
}

export function expectedGroups(items: readonly ShopItem[]): Record<string, string[]> {
  const groups: Record<string, string[]> = {}
  for (const item of matchingByPrice(items)) {
    const kept = groups[item.category] ?? []
    if (kept.length < KEPT_PER_GROUP) kept.push(item.id)
    groups[item.category] = kept
  }
  return groups
}

export function expectedPinnedPage(items: readonly ShopItem[]): string[] {
  return [pinnedOutsider(items).id, ...matchingByPrice(items).map(item => item.id)].slice(0, PAGE_SIZE)
}

export function expectedCategoryCounts(items: readonly ShopItem[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of matchingByPrice(items)) counts[item.category] = (counts[item.category] ?? 0) + 1
  return counts
}

export function groupsById(groups: ReadonlyArray<{ values: Record<string, unknown>; hits: Array<{ id: string }> }>) {
  const byCategory: Record<string, string[]> = {}
  for (const group of groups) byCategory[String(group.values.category)] = group.hits.map(hit => hit.id)
  return byCategory
}
