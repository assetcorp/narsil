#ifndef NARSIL_PATTERN_CACHE_H
#define NARSIL_PATTERN_CACHE_H

#include "../../include/narsil_core.h"
#include "program.h"
#include "simulation.h"

#include <stddef.h>
#include <stdint.h>

enum {
  CACHE_STATE_CHAIN,
  CACHE_STATE_HASH,
  CACHE_STATE_PREVIOUS,
  CACHE_STATE_COUNT,
  CACHE_STATE_END,
  CACHE_STATE_WORDS
};
enum {
  CACHE_EDGE_CHAIN,
  CACHE_EDGE_SOURCE,
  CACHE_EDGE_CLASS,
  CACHE_EDGE_TARGET,
  CACHE_EDGE_STEPS,
  CACHE_EDGE_OUTCOME,
  CACHE_EDGE_WORDS
};

typedef struct {
  uint32_t *words;
  size_t capacity;
  size_t limit;
  size_t used;
  uint32_t buckets;
  uint32_t start;
  uint32_t current;
  uint32_t exhausted;
} pattern_cache;

typedef struct {
  uint32_t source;
  uint32_t point_class;
  uint32_t target;
  uint32_t steps;
  uint32_t outcome;
} pattern_cache_edge;

narsil_status pattern_cache_prepare(const pattern_program *program, const pattern_simulation *simulation,
                                    pattern_cache *cache, uint32_t budget_bytes);
void pattern_cache_clear(pattern_cache *cache);
uint32_t pattern_cache_intern(pattern_cache *cache, pattern_simulation *simulation);
uint32_t pattern_cache_find_edge(const pattern_cache *cache, const pattern_cache_edge *edge);
void pattern_cache_store_edge(pattern_cache *cache, const pattern_cache_edge *edge);
void pattern_cache_load(const pattern_cache *cache, pattern_simulation *simulation);
void pattern_dfa_begin(pattern_cache *cache, pattern_simulation *simulation);
uint32_t pattern_dfa_step(const pattern_program *program, pattern_cache *cache, pattern_simulation *simulation,
                          uint32_t point);
int pattern_dfa_end(const pattern_program *program, pattern_cache *cache, pattern_simulation *simulation);

#endif
