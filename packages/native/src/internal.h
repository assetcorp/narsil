#ifndef NARSIL_CORE_INTERNAL_H
#define NARSIL_CORE_INTERNAL_H

#include "../include/narsil_core.h"

#include <stdatomic.h>
#include <stddef.h>
#include <stdint.h>

#define NODE_WRITE_HELD 1
#define NODE_WRITER_WAITING 2
#define NODE_VERSION_STEP 4U

#define QUERY_PLANES 4
#define MAX_M 512
#define MAX_NEIGHBOURS_PER_LIST ((2 * MAX_M) + 1)
#define BITS_PER_BYTE 8
#define TRAILER_LOWER 0
#define TRAILER_UPPER 4
#define TRAILER_CORRECTION 8
#define TRAILER_SUM 12
#define NO_ENTRY_POINT (-1)
#define NO_NODE (-1)

#ifdef NARSIL_PORTABLE_KERNELS
#elif defined(__aarch64__) || defined(_M_ARM64)
#define NARSIL_NEON 1
#elif defined(__SSE2__) || defined(_M_X64)
#define NARSIL_SSE2 1
#endif

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
  int32_t *ordinals;
  double *distances;
  uint32_t count;
  uint32_t capacity;
} scored_list;

typedef struct {
  double lower;
  double upper;
} level_range;

typedef struct {
  level_range range;
  double correction;
  const double *centred;
} quantised_vector;

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
  uint32_t candidate_limit;
  int32_t layer;
} layer_search;

typedef struct {
  int32_t graph_top;
  int32_t link_top;
} link_span;

typedef struct {
  int32_t ordinal;
  uint32_t former_count;
} removed_node;

typedef struct {
  const narsil_graph *graph;
  const narsil_store *store;
  narsil_workspace *workspace;
  narsil_metric metric;
  uint32_t thread_slot;
  int uses_codes;
  int pairs_use_codes;
  uint32_t slots;
  uint32_t store_slots;
  int skip_tombstones;
  uint32_t code_bytes;
  uint32_t record_bytes;
  double centroid_dot;
  float_query query;
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
  float *placed_vector;
  float *stored_vector;
  float *other_vector;
  prepared_code code;
  scored_list layer_candidates;
  scored_list link_candidates;
  scored_list repair_candidates;
  int32_t *selections;
  uint32_t *selection_counts;
  uint32_t selection_layers;
  uint32_t selection_stride;
  int32_t fence;
  int32_t neighbours[MAX_NEIGHBOURS_PER_LIST];
  int32_t former[MAX_NEIGHBOURS_PER_LIST];
  int32_t kept[MAX_NEIGHBOURS_PER_LIST];
  int32_t repaired[MAX_NEIGHBOURS_PER_LIST];
};

static inline int32_t load_word(const int32_t *words, uint32_t index) {
  return atomic_load((const _Atomic(int32_t) *)(words + index));
}

static inline _Atomic(int32_t) *atomic_word(int32_t *words, uint32_t index) {
  return (_Atomic(int32_t) *)(words + index);
}

static inline _Atomic(uint8_t) *atomic_byte(uint8_t *bytes, uint32_t index) {
  return (_Atomic(uint8_t) *)(bytes + index);
}

uint32_t grown_capacity(uint32_t first, uint32_t needed);

narsil_status heap_reserve(distance_heap *heap, uint32_t capacity);
void heap_release(distance_heap *heap);
narsil_status heap_push(distance_heap *heap, scored_node node);
int heap_pop(distance_heap *heap);

narsil_status list_reserve(scored_list *list, uint32_t capacity);
void list_release(scored_list *list);
void list_sort_nearest_first(scored_list *list);

void graph_lock_shared(const narsil_graph *graph, uint32_t thread_slot);
void graph_unlock_shared(const narsil_graph *graph, uint32_t thread_slot);
void node_lock(const walk_context *context, int32_t ordinal);
void node_unlock(const walk_context *context, int32_t ordinal);
void entry_lock(const narsil_graph *graph);
void entry_unlock(const narsil_graph *graph);
uint32_t read_neighbours(const walk_context *context, node_layer position, int32_t *out);

int32_t node_top_layer(const walk_context *context, int32_t ordinal);
int32_t *list_at(const walk_context *context, node_layer position, uint32_t *capacity);
uint32_t list_limit(const narsil_graph *graph, int32_t layer);
void list_add(const walk_context *context, node_layer position, int32_t neighbour);
void list_take_out(const walk_context *context, node_layer position, int32_t neighbour);
void list_replace(const walk_context *context, node_layer position, const int32_t *neighbours, uint32_t count);
uint32_t select_neighbours(const walk_context *context, scored_list *candidates, uint32_t limit, int32_t *selected);
void list_prune(const walk_context *context, node_layer position);
int32_t highest_node(const walk_context *context, int include_tombstoned);
void store_entry_point(const walk_context *context, int32_t ordinal);

narsil_status workspace_reserve_dimension(narsil_workspace *workspace, uint32_t dimension);
narsil_status workspace_reserve_visited(narsil_workspace *workspace, uint32_t slots);
narsil_status workspace_reserve_entry_points(narsil_workspace *workspace, uint32_t count);
narsil_status workspace_reserve_links(narsil_workspace *workspace, const narsil_graph *graph, uint32_t layers);

narsil_status begin_walk(walk_context *context, narsil_workspace *workspace, const narsil_graph *graph,
                         const narsil_store *store, uint32_t metric);
void walk_with_query(walk_context *context, const float *vector);
narsil_status read_graph_extent(walk_context *context);
void use_single_entry(narsil_workspace *workspace, int32_t ordinal);
narsil_status search_layer(const walk_context *context, layer_search search, narsil_candidates *out);
narsil_status descend_layers(const walk_context *context, int32_t first, int32_t last, narsil_candidates *out);

void normalise_into(double *normalised, const float *vector, uint32_t dimension);
void quantise_vector(narsil_workspace *workspace, const narsil_store *store, narsil_metric metric, const float *vector,
                     uint32_t bits, quantised_vector *quantised);
double quantised_level(double value, level_range range, uint32_t bits);
void prepare_code(narsil_workspace *workspace, const narsil_store *store, narsil_metric metric, const float *vector,
                  prepared_code *code);
uint32_t code_bytes_of(uint32_t dimension, uint32_t bits);
uint32_t query_bits_of(uint32_t bits);
double estimate_distance(const walk_context *context, const uint8_t *record);
double estimate_pair_distance(const walk_context *context, const uint8_t *first, const uint8_t *second);
double pair_distance(const walk_context *context, int32_t first, int32_t second);

float kernel_dot(const float *lhs, const float *rhs, uint32_t dimension);
float kernel_squared_distance(const float *lhs, const float *rhs, uint32_t dimension);
float kernel_magnitude(const float *values, uint32_t dimension);
uint32_t kernel_products_8x8(const uint8_t *document, const uint8_t *query, uint32_t dimension);
uint32_t kernel_products_4x4(const uint8_t *document, const uint8_t *low, const uint8_t *high, uint32_t bytes);
uint32_t kernel_products_bits(packed_code document, const uint8_t *planes);
uint32_t kernel_pair_products(packed_code first, const uint8_t *second, uint32_t dimension);

int is_metric(uint32_t metric);
int is_code_width(uint32_t bits);
int store_is_complete(const narsil_store *store);
int graph_is_complete(const narsil_graph *graph);
const float *stored_vector(const narsil_store *store, int32_t ordinal, float *scratch);
uint8_t *stored_record(const narsil_store *store, int32_t ordinal);
double float_distance(const walk_context *context, float_query query, int32_t ordinal);
double walk_distance(const walk_context *context, int32_t ordinal);
void prefetch_for_walk(const walk_context *context, int32_t ordinal);

#endif
