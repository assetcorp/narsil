#ifndef NARSIL_CORE_H
#define NARSIL_CORE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define NARSIL_CORE_ABI_VERSION 1

#define NARSIL_GRAPH_HEADER_WORDS 160
#define NARSIL_STORE_HEADER_WORDS 16
#define NARSIL_HELD_WORDS_PER_THREAD 32
#define NARSIL_OSQ_TRAILER_BYTES 16
#define NARSIL_MAX_PLACEMENT_LAYERS 64

#define NARSIL_GRAPH_WORD_ENTRY_POINT 0
#define NARSIL_GRAPH_WORD_TOP_LAYER 1
#define NARSIL_GRAPH_WORD_M 2
#define NARSIL_GRAPH_WORD_MMAX0 3
#define NARSIL_GRAPH_WORD_EF_CONSTRUCTION 4
#define NARSIL_GRAPH_WORD_NODE_COUNT 32
#define NARSIL_GRAPH_WORD_UPPER_USED 64
#define NARSIL_GRAPH_WORD_SLOTS 65
#define NARSIL_GRAPH_WORD_LOCK 96
#define NARSIL_GRAPH_WORD_WRITERS_WAITING 97

#define NARSIL_STORE_WORD_SLOTS 0
#define NARSIL_STORE_WORD_LIVE_COUNT 1
#define NARSIL_STORE_WORD_CALIBRATED 3
#define NARSIL_STORE_WORD_CODE_COUNT 4

#define NARSIL_HELD_WORD_GRAPH 2

typedef enum {
  NARSIL_METRIC_COSINE = 0,
  NARSIL_METRIC_DOT_PRODUCT = 1,
  NARSIL_METRIC_EUCLIDEAN = 2,
} narsil_metric;

typedef enum {
  NARSIL_OK = 0,
  NARSIL_INVALID_ARGUMENT = 1,
  NARSIL_OUT_OF_MEMORY = 2,
  NARSIL_UNSUPPORTED_PROCESSOR = 3,
} narsil_status;

typedef struct {
  int32_t *header;
  const uint8_t *node_levels;
  const int32_t *level0;
  const int32_t *upper_base;
  const int32_t *upper;
  int32_t *locks;
  const uint8_t *tombstones;
  int32_t *held_locks;
  uint32_t thread_slots;
} narsil_graph;

typedef struct {
  const int32_t *header;
  uint32_t dimension;
  uint32_t bits;
  const uint8_t *const *code_blocks;
  uint32_t code_block_count;
  uint32_t records_per_block;
  const uint8_t *code_present;
  const float *centroid;
  const float *const *vector_blocks;
  uint32_t vector_block_count;
  uint32_t vectors_per_block;
  uint32_t vector_stride_floats;
  const double *magnitudes;
  const uint8_t *present;
} narsil_store;

typedef struct narsil_workspace narsil_workspace;

typedef struct {
  int32_t *ordinals;
  double *distances;
  uint32_t capacity;
  uint32_t count;
} narsil_candidates;

typedef struct {
  const float *query;
  uint32_t metric;
  uint32_t candidate_count;
  uint32_t thread_slot;
} narsil_search_request;

typedef struct {
  const float *vector;
  uint32_t metric;
  int32_t own_ordinal;
  int32_t top_layer;
  uint32_t thread_slot;
} narsil_place_request;

typedef struct {
  narsil_candidates *per_layer;
  uint32_t layer_count;
  int32_t linked_top_layer;
} narsil_placement;

int32_t narsil_core_abi_version(void);

narsil_status narsil_workspace_create(narsil_workspace **workspace);
void narsil_workspace_destroy(narsil_workspace *workspace);
size_t narsil_workspace_bytes(const narsil_workspace *workspace);

narsil_status narsil_search(narsil_workspace *workspace, const narsil_graph *graph, const narsil_store *store,
                            const narsil_search_request *request, narsil_candidates *nearest);

narsil_status narsil_place(narsil_workspace *workspace, const narsil_graph *graph, const narsil_store *store,
                           const narsil_place_request *request, narsil_placement *placement);

narsil_status narsil_rescore(const narsil_store *store, const float *query, uint32_t metric, const int32_t *ordinals,
                             uint32_t count, double *distances);

#ifdef __cplusplus
}
#endif

#endif
