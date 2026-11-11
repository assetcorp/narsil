#include "term_cache.h"

#include "../allocation.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define TERM_CACHE_SLOTS 16384U
#define TERM_CACHE_WAYS 8U
#define TERM_CACHE_SETS (TERM_CACHE_SLOTS / TERM_CACHE_WAYS)
#define TERM_CACHE_SET_MASK (TERM_CACHE_SETS - 1U)
#define TERM_FNV_OFFSET_BASIS 2166136261U
#define TERM_FNV_PRIME 16777619U
#define TERM_TAG_LANGUAGE_SHIFT 8U
#define TERM_TAG_EMPTY 0U

static uint32_t tag_of(const narsil_term_key *key) {
  return ((key->language_index + 1U) << TERM_TAG_LANGUAGE_SHIFT) | key->flags;
}

static int holds(const narsil_term_slot *slot, uint32_t tag, const narsil_term_key *key) {
  return slot->tag == tag && slot->key_length == key->length &&
         memcmp(slot->key, key->units, key->length * sizeof *key->units) == 0;
}

static int prepared(narsil_term_cache *cache) {
  if (cache->slots != NULL) { return 1; }
  if (cache->unavailable) { return 0; }
  cache->slots = core_allocate_zeroed(TERM_CACHE_SLOTS, sizeof *cache->slots);
  cache->next_victim = core_allocate_zeroed(TERM_CACHE_SETS, sizeof *cache->next_victim);
  if (cache->slots == NULL || cache->next_victim == NULL) {
    free(cache->slots);
    free(cache->next_victim);
    cache->slots = NULL;
    cache->next_victim = NULL;
    cache->unavailable = 1;
    return 0;
  }
  return 1;
}

narsil_term_slot *narsil_term_cache_find(narsil_term_cache *cache, const narsil_term_key *key,
                                         narsil_term_slot **victim) {
  *victim = NULL;
  if (key->length == 0 || key->length > NARSIL_TERM_CACHE_UNITS || !prepared(cache)) { return NULL; }
  uint32_t tag = tag_of(key);
  uint32_t hash = (TERM_FNV_OFFSET_BASIS ^ tag) * TERM_FNV_PRIME;
  for (size_t unit = 0; unit < key->length; unit++) {
    hash ^= key->units[unit];
    hash *= TERM_FNV_PRIME;
  }
  uint32_t set = hash & TERM_CACHE_SET_MASK;
  narsil_term_slot *ways = &cache->slots[(size_t)set * TERM_CACHE_WAYS];
  narsil_term_slot *empty = NULL;
  for (uint32_t way = 0; way < TERM_CACHE_WAYS; way++) {
    if (holds(&ways[way], tag, key)) { return &ways[way]; }
    if (empty == NULL && ways[way].tag == TERM_TAG_EMPTY) { empty = &ways[way]; }
  }
  if (empty == NULL) {
    uint8_t *next = &cache->next_victim[set];
    empty = &ways[*next];
    *next = (uint8_t)((*next + 1U) % TERM_CACHE_WAYS);
  }
  *victim = empty;
  return NULL;
}

int narsil_term_cache_store(narsil_term_slot *slot, const narsil_term_key *key, const uint16_t *value, size_t length) {
  if (length == 0 || length > NARSIL_TERM_CACHE_UNITS) { return 0; }
  slot->tag = tag_of(key);
  slot->key_length = (uint16_t)key->length;
  memcpy(slot->key, key->units, key->length * sizeof *key->units);
  slot->value_length = (uint16_t)length;
  memcpy(slot->value, value, length * sizeof *value);
  return 1;
}

uint32_t narsil_term_cache_index(const narsil_term_cache *cache, const narsil_term_slot *slot) {
  return (uint32_t)(slot - cache->slots);
}

void narsil_term_cache_release(narsil_term_cache *cache) {
  free(cache->slots);
  free(cache->next_victim);
  cache->slots = NULL;
  cache->next_victim = NULL;
  cache->unavailable = 0;
}
