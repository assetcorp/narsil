#include "internal.h"

#include "../include/narsil_core.h"

#include <stdatomic.h>
#include <stddef.h>
#include <stdint.h>

#ifdef _WIN32
#include <windows.h>
#else
#include <sched.h>
#endif

#define LOCK_SPIN_ITERATIONS 128
#define LIST_COUNT_WORDS 1

static inline _Atomic(int32_t) *atomic_word(int32_t *words, uint32_t index) {
  return (_Atomic(int32_t) *)(words + index);
}

static inline void yield_thread(void) {
#ifdef _WIN32
  SwitchToThread();
#else
  sched_yield();
#endif
}

static inline void wait_for_the_lock(uint32_t *waits) {
  if (*waits < LOCK_SPIN_ITERATIONS) {
    *waits += 1;
    return;
  }
  yield_thread();
}

static inline uint32_t held_index(uint32_t thread_slot, uint32_t kind) {
  return (thread_slot * NARSIL_HELD_WORDS_PER_THREAD) + kind;
}

void graph_lock_shared(const narsil_graph *graph, uint32_t thread_slot) {
  _Atomic(int32_t) *lock = atomic_word(graph->header, NARSIL_GRAPH_WORD_LOCK);
  _Atomic(int32_t) *writers_waiting = atomic_word(graph->header, NARSIL_GRAPH_WORD_WRITERS_WAITING);
  uint32_t waits = 0;
  for (;;) {
    int32_t seen = atomic_load(lock);
    if (seen >= 0 && atomic_load(writers_waiting) == 0) {
      if (atomic_compare_exchange_strong(lock, &seen, seen + 1)) {
        atomic_store(atomic_word(graph->held_locks, held_index(thread_slot, NARSIL_HELD_WORD_GRAPH)), 1);
        return;
      }
      continue;
    }
    wait_for_the_lock(&waits);
  }
}

void graph_unlock_shared(const narsil_graph *graph, uint32_t thread_slot) {
  atomic_store(atomic_word(graph->held_locks, held_index(thread_slot, NARSIL_HELD_WORD_GRAPH)), 0);
  atomic_fetch_sub(atomic_word(graph->header, NARSIL_GRAPH_WORD_LOCK), 1);
}

static uint32_t list_of(const walk_context *context, node_layer position, const int32_t **list) {
  const narsil_graph *graph = context->graph;
  int32_t level = (int32_t)graph->node_levels[position.ordinal] - 1;
  if (level < 0 || position.layer > level) { return 0; }
  int32_t max_neighbours = load_word(graph->header, NARSIL_GRAPH_WORD_M);
  int32_t max_base_neighbours = load_word(graph->header, NARSIL_GRAPH_WORD_MMAX0);
  if (max_neighbours <= 0 || max_base_neighbours <= 0) { return 0; }
  if (position.layer == 0) {
    size_t base_stride = (size_t)max_base_neighbours + NARSIL_LIST_WORDS_OVER_NEIGHBOURS;
    *list = graph->level0 + ((size_t)position.ordinal * base_stride);
    return (uint32_t)(base_stride - LIST_COUNT_WORDS);
  }
  int32_t base = graph->upper_base[position.ordinal];
  if (base <= 0) { return 0; }
  uint64_t stride = (uint64_t)max_neighbours + NARSIL_LIST_WORDS_OVER_NEIGHBOURS;
  uint64_t start = (uint64_t)(base - 1) + ((uint64_t)(position.layer - 1) * stride);
  if (start + stride > context->upper_used) { return 0; }
  *list = graph->upper + start;
  return (uint32_t)(stride - LIST_COUNT_WORDS);
}

uint32_t read_neighbours(const walk_context *context, node_layer position, int32_t *out) {
  const narsil_graph *graph = context->graph;
  _Atomic(int32_t) *word = atomic_word(graph->locks, (uint32_t)position.ordinal);
  _Atomic(int32_t) *fence = atomic_word(context->fence, 0);
  uint32_t waits = 0;
  for (;;) {
    int32_t before = atomic_load(word);
    if ((before & NODE_WRITE_HELD) != 0) {
      wait_for_the_lock(&waits);
      continue;
    }
    const int32_t *list = NULL;
    uint32_t capacity = list_of(context, position, &list);
    uint32_t count = 0;
    if (capacity > 0) {
      int32_t stored = list[0];
      count = stored < 0 ? 0 : (uint32_t)stored;
      if (count > capacity) { count = capacity; }
      if (count > MAX_NEIGHBOURS_PER_LIST) { count = MAX_NEIGHBOURS_PER_LIST; }
      for (uint32_t i = 0; i < count; i++) { out[i] = list[i + 1]; }
    }
    atomic_fetch_add(fence, 0);
    if (atomic_load(word) == before) { return count; }
  }
}
