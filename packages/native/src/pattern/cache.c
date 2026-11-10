#include "cache.h"

#include "../../include/narsil_core.h"
#include "../allocation.h"
#include "program.h"
#include "simulation.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define CACHE_HASH_OFFSET UINT32_C(2166136261)
#define CACHE_HASH_PRIME UINT32_C(16777619)

static uint32_t hash_word(uint32_t hash, const uint32_t *word) { return (hash ^ *word) * CACHE_HASH_PRIME; }

static uint64_t matcher_bytes(const pattern_program *program, const pattern_simulation *simulation) {
  uint64_t words = program->predicates.ranges.capacity + (uint64_t)program->class_edges.capacity;
  words += simulation->marks.capacity + (uint64_t)simulation->stack.capacity;
  words += simulation->candidates.capacity + (uint64_t)simulation->after.capacity + simulation->starts.capacity;
  return (program->capacity * (uint64_t)sizeof *program->states) + (words * sizeof(uint32_t)) +
         sizeof program->direct_classes + sizeof simulation->start_counts;
}

narsil_status pattern_cache_prepare(const pattern_program *program, const pattern_simulation *simulation,
                                    pattern_cache *cache, uint32_t budget_bytes) {
  cache->limit = 0;
  cache->buckets = 0;
  uint64_t held = matcher_bytes(program, simulation);
  size_t words = held < budget_bytes ? (size_t)((budget_bytes - held) / sizeof *cache->words) : 0;
  size_t target = words / (CACHE_STATE_WORDS + CACHE_EDGE_WORDS + 2);
  if (target > 0) {
    if (words > cache->capacity) {
      uint32_t *allocation = core_reallocate(cache->words, words * sizeof *allocation);
      if (allocation == NULL) { return NARSIL_OUT_OF_MEMORY; }
      cache->words = allocation;
      cache->capacity = words;
    }
    cache->limit = words;
    cache->buckets = 1;
    while ((size_t)cache->buckets * 2 <= target) { cache->buckets *= 2; }
  }
  pattern_cache_clear(cache);
  return NARSIL_OK;
}

void pattern_cache_clear(pattern_cache *cache) {
  cache->used = (size_t)cache->buckets * 2;
  cache->start = 0;
  cache->current = 0;
  cache->exhausted = 0;
  if (cache->used > 0) { memset(cache->words, 0, cache->used * sizeof *cache->words); }
}

static int compare_positions(const void *first, const void *second) {
  uint32_t left = *(const uint32_t *)first;
  uint32_t right = *(const uint32_t *)second;
  if (left == right) { return 0; }
  return left < right ? -1 : 1;
}

static uint32_t reserve_words(pattern_cache *cache, size_t count) {
  if (cache->buckets == 0 || count > cache->limit - cache->used) {
    cache->exhausted = 1;
    return 0;
  }
  uint32_t offset = (uint32_t)cache->used;
  cache->used += count;
  return offset;
}

uint32_t pattern_cache_intern(pattern_cache *cache, pattern_simulation *simulation) {
  if (cache->buckets == 0) { return 0; }
  narsil_code_points *after = &simulation->after;
  if (after->length > 1) { qsort(after->values, after->length, sizeof *after->values, compare_positions); }
  uint32_t hash = hash_word(CACHE_HASH_OFFSET, &simulation->previous_kind);
  for (size_t at = 0; at < after->length; at++) { hash = hash_word(hash, after->values + at); }
  uint32_t bucket = hash & (cache->buckets - 1);
  for (uint32_t offset = cache->words[bucket]; offset != 0; offset = cache->words[offset + CACHE_STATE_CHAIN]) {
    const uint32_t *state = cache->words + offset;
    if (state[CACHE_STATE_HASH] != hash || state[CACHE_STATE_PREVIOUS] != simulation->previous_kind ||
        state[CACHE_STATE_COUNT] != after->length) {
      continue;
    }
    if (after->length == 0 ||
        memcmp(state + CACHE_STATE_WORDS, after->values, after->length * sizeof *after->values) == 0) {
      return offset;
    }
  }
  uint32_t offset = reserve_words(cache, CACHE_STATE_WORDS + after->length);
  if (offset == 0) { return 0; }
  uint32_t *state = cache->words + offset;
  state[CACHE_STATE_CHAIN] = cache->words[bucket];
  state[CACHE_STATE_HASH] = hash;
  state[CACHE_STATE_PREVIOUS] = simulation->previous_kind;
  state[CACHE_STATE_COUNT] = (uint32_t)after->length;
  state[CACHE_STATE_END] = UINT32_MAX;
  if (after->length > 0) { memcpy(state + CACHE_STATE_WORDS, after->values, after->length * sizeof *after->values); }
  cache->words[bucket] = offset;
  return offset;
}

static uint32_t edge_bucket(const pattern_cache *cache, const pattern_cache_edge *edge) {
  uint32_t hash = hash_word(hash_word(CACHE_HASH_OFFSET, &edge->source), &edge->point_class);
  return cache->buckets + (hash & (cache->buckets - 1));
}

uint32_t pattern_cache_find_edge(const pattern_cache *cache, const pattern_cache_edge *edge) {
  if (cache->buckets == 0) { return 0; }
  for (uint32_t offset = cache->words[edge_bucket(cache, edge)]; offset != 0;
       offset = cache->words[offset + CACHE_EDGE_CHAIN]) {
    const uint32_t *stored = cache->words + offset;
    if (stored[CACHE_EDGE_SOURCE] == edge->source && stored[CACHE_EDGE_CLASS] == edge->point_class) { return offset; }
  }
  return 0;
}

void pattern_cache_store_edge(pattern_cache *cache, const pattern_cache_edge *edge) {
  uint32_t offset = reserve_words(cache, CACHE_EDGE_WORDS);
  if (offset == 0) { return; }
  uint32_t bucket = edge_bucket(cache, edge);
  uint32_t *stored = cache->words + offset;
  stored[CACHE_EDGE_CHAIN] = cache->words[bucket];
  stored[CACHE_EDGE_SOURCE] = edge->source;
  stored[CACHE_EDGE_CLASS] = edge->point_class;
  stored[CACHE_EDGE_TARGET] = edge->target;
  stored[CACHE_EDGE_STEPS] = edge->steps;
  stored[CACHE_EDGE_OUTCOME] = edge->outcome;
  cache->words[bucket] = offset;
}

void pattern_cache_load(const pattern_cache *cache, pattern_simulation *simulation) {
  const uint32_t *state = cache->words + cache->current;
  simulation->previous_kind = state[CACHE_STATE_PREVIOUS];
  simulation->after.length = state[CACHE_STATE_COUNT];
  if (simulation->after.length > 0) {
    memcpy(simulation->after.values, state + CACHE_STATE_WORDS, simulation->after.length * sizeof *state);
  }
}
