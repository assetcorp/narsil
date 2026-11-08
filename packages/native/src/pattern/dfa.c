#include "cache.h"

#include "program.h"
#include "simulation.h"

#include <stdint.h>

void pattern_dfa_begin(pattern_cache *cache, pattern_simulation *simulation) {
  pattern_simulation_reset(simulation);
  if (cache->exhausted != 0) { pattern_cache_clear(cache); }
  if (cache->start == 0) { cache->start = pattern_cache_intern(cache, simulation); }
  cache->current = cache->start;
}

uint32_t pattern_dfa_step(const pattern_program *program, pattern_cache *cache, pattern_simulation *simulation,
                          uint32_t point) {
  if (cache->current == 0) { return pattern_simulation_step(program, simulation, point); }
  pattern_cache_edge edge = {cache->current, pattern_class_of(program, point), 0, 0, 0};
  uint32_t found = pattern_cache_find_edge(cache, &edge);
  if (found != 0) {
    const uint32_t *stored = cache->words + found;
    simulation->steps = stored[CACHE_EDGE_STEPS];
    cache->current = stored[CACHE_EDGE_TARGET];
    return stored[CACHE_EDGE_OUTCOME];
  }
  pattern_cache_load(cache, simulation);
  edge.outcome = pattern_simulation_step(program, simulation, point);
  edge.steps = simulation->steps;
  if (edge.outcome == PATTERN_STEP_CONTINUES) { edge.target = pattern_cache_intern(cache, simulation); }
  if (edge.target != 0 || edge.outcome != PATTERN_STEP_CONTINUES) { pattern_cache_store_edge(cache, &edge); }
  cache->current = edge.target;
  return edge.outcome;
}

int pattern_dfa_end(const pattern_program *program, pattern_cache *cache, pattern_simulation *simulation) {
  if (cache->current == 0) { return pattern_simulation_end(program, simulation); }
  uint32_t *state = cache->words + cache->current;
  if (state[CACHE_STATE_END] == UINT32_MAX) {
    pattern_cache_load(cache, simulation);
    state[CACHE_STATE_END] = (uint32_t)pattern_simulation_end(program, simulation);
  }
  return state[CACHE_STATE_END] != 0;
}
