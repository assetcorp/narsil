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
#define LOCK_FREE 0
#define LOCK_HELD_ALONE (-1)

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

void node_lock(const walk_context *context, int32_t ordinal) {
  const narsil_graph *graph = context->graph;
  uint32_t thread_slot = context->thread_slot;
  _Atomic(int32_t) *word = atomic_word(graph->locks, (uint32_t)ordinal);
  uint32_t waits = 0;
  for (;;) {
    int32_t seen = atomic_load(word);
    if ((seen & NODE_WRITE_HELD) == 0) {
      int32_t claimed = seen | NODE_WRITE_HELD;
      if (atomic_compare_exchange_strong(word, &seen, claimed)) {
        atomic_store(atomic_word(graph->held_locks, held_index(thread_slot, NARSIL_HELD_WORD_NODE_VALUE)), claimed);
        atomic_store(atomic_word(graph->held_locks, held_index(thread_slot, NARSIL_HELD_WORD_NODE)), ordinal + 1);
        return;
      }
      continue;
    }
    wait_for_the_lock(&waits);
  }
}

void node_unlock(const walk_context *context, int32_t ordinal) {
  const narsil_graph *graph = context->graph;
  _Atomic(int32_t) *word = atomic_word(graph->locks, (uint32_t)ordinal);
  uint32_t seen = (uint32_t)atomic_load(word);
  uint32_t released = (seen & ~(uint32_t)(NODE_WRITE_HELD | NODE_WRITER_WAITING)) + NODE_VERSION_STEP;
  int32_t previous = atomic_exchange(word, (int32_t)released);
  if ((previous & NODE_WRITER_WAITING) != 0 && graph->wake != NULL) { graph->wake(graph->wake_context, ordinal); }
  atomic_store(atomic_word(graph->held_locks, held_index(context->thread_slot, NARSIL_HELD_WORD_NODE)), 0);
}

void entry_lock(const narsil_graph *graph) {
  _Atomic(int32_t) *lock = atomic_word(graph->header, NARSIL_GRAPH_WORD_ENTRY_LOCK);
  uint32_t waits = 0;
  for (;;) {
    int32_t expected = LOCK_FREE;
    if (atomic_compare_exchange_strong(lock, &expected, LOCK_HELD_ALONE)) { return; }
    wait_for_the_lock(&waits);
  }
}

void entry_unlock(const narsil_graph *graph) {
  atomic_store(atomic_word(graph->header, NARSIL_GRAPH_WORD_ENTRY_LOCK), LOCK_FREE);
  if (graph->wake != NULL) { graph->wake(graph->wake_context, NARSIL_WAKE_ENTRY_LOCK); }
}

int32_t node_top_layer(const walk_context *context, int32_t ordinal) {
  if (ordinal < 0 || (uint32_t)ordinal >= context->slots) { return NO_NODE; }
  return (int32_t)atomic_load(atomic_byte(context->graph->node_levels, (uint32_t)ordinal)) - 1;
}

uint32_t list_limit(const narsil_graph *graph, int32_t layer) {
  int32_t limit = load_word(graph->header, layer == 0 ? NARSIL_GRAPH_WORD_MMAX0 : NARSIL_GRAPH_WORD_M);
  return limit <= 0 ? 0 : (uint32_t)limit;
}

int32_t *list_at(const walk_context *context, node_layer position, uint32_t *capacity) {
  const narsil_graph *graph = context->graph;
  *capacity = 0;
  int32_t level = node_top_layer(context, position.ordinal);
  if (level < 0 || position.layer < 0 || position.layer > level) { return NULL; }
  if (graph->level0 == NULL || graph->upper == NULL || graph->upper_base == NULL) { return NULL; }
  uint32_t limit = list_limit(graph, position.layer);
  if (limit == 0 || limit >= MAX_NEIGHBOURS_PER_LIST) { return NULL; }
  uint64_t stride = (uint64_t)limit + NARSIL_LIST_WORDS_OVER_NEIGHBOURS;
  if (position.layer == 0) {
    *capacity = (uint32_t)(stride - LIST_COUNT_WORDS);
    return graph->level0 + ((size_t)position.ordinal * stride);
  }
  int32_t base = graph->upper_base[position.ordinal];
  if (base <= 0) { return NULL; }
  uint64_t start = (uint64_t)(base - 1) + ((uint64_t)(position.layer - 1) * stride);
  int32_t upper_used = load_word(graph->header, NARSIL_GRAPH_WORD_UPPER_USED);
  if (upper_used < 0 || start + stride > (uint64_t)upper_used) { return NULL; }
  *capacity = (uint32_t)(stride - LIST_COUNT_WORDS);
  return graph->upper + start;
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
    uint32_t capacity = 0;
    const int32_t *list = list_at(context, position, &capacity);
    uint32_t count = 0;
    if (list != NULL) {
      int32_t stored = list[0];
      count = stored < 0 ? 0 : (uint32_t)stored;
      if (count > capacity) { count = capacity; }
      for (uint32_t i = 0; i < count; i++) { out[i] = list[i + 1]; }
    }
    atomic_fetch_add(fence, 0);
    if (atomic_load(word) == before) { return count; }
  }
}
