#ifndef NARSIL_CORE_INTERNAL_H
#define NARSIL_CORE_INTERNAL_H

#include "../include/narsil_core.h"

#include <stdatomic.h>
#include <stddef.h>
#include <stdint.h>

#define NODE_WRITE_HELD 1

#define QUERY_PLANES 4
#define MAX_NEIGHBOURS_PER_LIST 512
#define BITS_PER_BYTE 8

typedef struct {
  int32_t ordinal;
  double distance;
} scored_node;

typedef struct {
  int32_t *ordinals;
  double *distances;
  uint32_t size;
  uint32_t capacity;
  int greatest_first;
  scored_node top;
} distance_heap;

typedef struct {
  double lower;
  double upper;
} level_range;

typedef struct {
  uint32_t bits;
  level_range range;
  double correction;
  double sum;
  uint8_t *levels;
  uint8_t *low_levels;
  uint8_t *high_levels;
  uint8_t *planes;
} prepared_code;

typedef struct {
  const uint8_t *bytes;
  uint32_t byte_count;
  uint32_t bits;
} packed_code;

typedef struct {
  const float *values;
  double magnitude;
} float_query;

typedef struct {
  int32_t ordinal;
  int32_t layer;
} node_layer;

typedef struct {
  const narsil_graph *graph;
  const narsil_store *store;
  narsil_metric metric;
  int uses_codes;
  uint32_t slots;
  uint32_t store_slots;
  uint32_t upper_used;
  uint32_t thread_slot;
  int skip_tombstones;
  uint32_t code_bytes;
  uint32_t record_bytes;
  double centroid_dot;
  float_query query;
  int32_t own_ordinal;
  int32_t *fence;
  prepared_code code;
} walk_context;

struct narsil_workspace {
  distance_heap frontier;
  distance_heap found;
  uint32_t *visited;
  uint32_t visited_capacity;
  uint32_t stamp;
  int32_t *entry_points;
  uint32_t entry_point_count;
  uint32_t entry_point_capacity;
  uint32_t dimension_capacity;
  size_t dimension_scratch_bytes;
  double *normalised;
  double *centred;
  prepared_code code;
  int32_t fence;
  int32_t neighbours[MAX_NEIGHBOURS_PER_LIST];
};

static inline int32_t load_word(const int32_t *words, uint32_t index) {
  return atomic_load((const _Atomic(int32_t) *)(words + index));
}

narsil_status heap_reserve(distance_heap *heap, uint32_t capacity);
void heap_release(distance_heap *heap);
narsil_status heap_push(distance_heap *heap, scored_node node);
int heap_pop(distance_heap *heap);

void graph_lock_shared(const narsil_graph *graph, uint32_t thread_slot);
void graph_unlock_shared(const narsil_graph *graph, uint32_t thread_slot);
uint32_t read_neighbours(const walk_context *context, node_layer position, int32_t *out);

narsil_status workspace_reserve_dimension(narsil_workspace *workspace, uint32_t dimension);
narsil_status workspace_reserve_visited(narsil_workspace *workspace, uint32_t slots);
narsil_status workspace_reserve_entry_points(narsil_workspace *workspace, uint32_t count);

void prepare_code(narsil_workspace *workspace, const narsil_store *store, narsil_metric metric, const float *vector,
                  prepared_code *code);
uint32_t code_bytes_of(uint32_t dimension, uint32_t bits);
uint32_t query_bits_of(uint32_t bits);
double estimate_distance(const walk_context *context, const uint8_t *record);

float kernel_dot(const float *lhs, const float *rhs, uint32_t dimension);
float kernel_squared_distance(const float *lhs, const float *rhs, uint32_t dimension);
float kernel_magnitude(const float *values, uint32_t dimension);
uint32_t kernel_products_8x8(const uint8_t *document, const uint8_t *query, uint32_t dimension);
uint32_t kernel_products_4x4(const uint8_t *document, const uint8_t *low, const uint8_t *high, uint32_t bytes);
uint32_t kernel_products_bits(packed_code document, const uint8_t *planes);

int is_metric(uint32_t metric);
int store_is_complete(const narsil_store *store);
double float_distance(const narsil_store *store, narsil_metric metric, float_query query, int32_t ordinal);
double walk_distance(const walk_context *context, int32_t ordinal);
void prefetch_for_walk(const walk_context *context, int32_t ordinal);

#endif
