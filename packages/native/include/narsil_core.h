#ifndef NARSIL_CORE_H
#define NARSIL_CORE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define NARSIL_CORE_ABI_VERSION 2

#define NARSIL_GRAPH_HEADER_WORDS 160
#define NARSIL_STORE_HEADER_WORDS 16
#define NARSIL_HELD_WORDS_PER_THREAD 32
#define NARSIL_OSQ_TRAILER_BYTES 16
#define NARSIL_MAX_PLACEMENT_LAYERS 64
#define NARSIL_LIST_WORDS_OVER_NEIGHBOURS 2

#define NARSIL_GRAPH_WORD_ENTRY_POINT 0
#define NARSIL_GRAPH_WORD_TOP_LAYER 1
#define NARSIL_GRAPH_WORD_M 2
#define NARSIL_GRAPH_WORD_MMAX0 3
#define NARSIL_GRAPH_WORD_EF_CONSTRUCTION 4
#define NARSIL_GRAPH_WORD_NODE_COUNT 32
#define NARSIL_GRAPH_WORD_TOMBSTONE_COUNT 33
#define NARSIL_GRAPH_WORD_UPPER_USED 64
#define NARSIL_GRAPH_WORD_SLOTS 65
#define NARSIL_GRAPH_WORD_UPPER_CAPACITY 66
#define NARSIL_GRAPH_WORD_SLOT_CAPACITY 67
#define NARSIL_GRAPH_WORD_LOCK 96
#define NARSIL_GRAPH_WORD_WRITERS_WAITING 97
#define NARSIL_GRAPH_WORD_ENTRY_LOCK 128

#define NARSIL_STORE_WORD_SLOTS 0
#define NARSIL_STORE_WORD_LIVE_COUNT 1
#define NARSIL_STORE_WORD_CALIBRATED 3
#define NARSIL_STORE_WORD_CODE_COUNT 4
#define NARSIL_STORE_WORD_CALIBRATION_GENERATION 7

#define NARSIL_HELD_WORD_NODE 0
#define NARSIL_HELD_WORD_NODE_VALUE 1
#define NARSIL_HELD_WORD_GRAPH 2

#define NARSIL_VECTOR_IN_A_BLOCK (-1)
#define NARSIL_GRAPH_HELD_ALONE (-1)
#define NARSIL_WAKE_ENTRY_LOCK (-1)

typedef enum {
  NARSIL_METRIC_COSINE = 0,
  NARSIL_METRIC_DOT_PRODUCT = 1,
  NARSIL_METRIC_EUCLIDEAN = 2,
} narsil_metric;

typedef enum {
  NARSIL_OK = 0,
  NARSIL_INVALID_ARGUMENT = 1,
  NARSIL_OUT_OF_MEMORY = 2,
  NARSIL_NEEDS_ROOM = 3,
  NARSIL_GRAPH_NOT_HELD_ALONE = 4,
  NARSIL_FILE_UNREADABLE = 5,
} narsil_status;

typedef void (*narsil_wake)(void *context, int32_t ordinal);

typedef struct {
  int32_t *header;
  uint8_t *node_levels;
  int32_t *level0;
  int32_t *upper_base;
  int32_t *upper;
  int32_t *locks;
  uint8_t *tombstones;
  int32_t *held_locks;
  uint32_t thread_slots;
  narsil_wake wake;
  void *wake_context;
} narsil_graph;

typedef struct {
  const uint8_t *bytes;
  uint64_t length;
  void *mapping;
} narsil_vector_file;

typedef struct {
  int32_t *header;
  uint32_t dimension;
  uint32_t bits;
  uint8_t *const *code_blocks;
  uint32_t code_block_count;
  uint32_t records_per_block;
  uint8_t *code_present;
  float *centroid;
  const float *const *vector_blocks;
  uint32_t vector_block_count;
  uint32_t vectors_per_block;
  uint32_t vector_stride_floats;
  const double *magnitudes;
  const uint8_t *present;
  const int32_t *vector_file;
  const uint32_t *vector_offset;
  const narsil_vector_file *files;
  uint32_t file_count;
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
  const float *query;
  uint32_t metric;
  const int32_t *ordinals;
  uint32_t count;
} narsil_score_request;

typedef struct {
  uint32_t metric;
  int32_t ordinal;
  int32_t top_layer;
  uint32_t thread_slot;
  uint32_t graph_held_alone;
} narsil_place_request;

typedef struct {
  int32_t ordinal;
  uint32_t thread_slot;
} narsil_remove_request;

typedef struct {
  uint32_t metric;
  uint32_t thread_slot;
} narsil_compact_request;

typedef struct {
  uint32_t metric;
  const int32_t *ordinals;
  uint32_t count;
} narsil_ordinals_request;

int32_t narsil_core_abi_version(void);
uint32_t narsil_record_bytes(uint32_t dimension, uint32_t bits);

narsil_status narsil_workspace_create(narsil_workspace **workspace);
void narsil_workspace_destroy(narsil_workspace *workspace);
size_t narsil_workspace_bytes(const narsil_workspace *workspace);

narsil_status narsil_vector_file_map(const char *path, narsil_vector_file *file);
void narsil_vector_file_unmap(narsil_vector_file *file);

narsil_status narsil_search(narsil_workspace *workspace, const narsil_graph *graph, const narsil_store *store,
                            const narsil_search_request *request, narsil_candidates *nearest);

narsil_status narsil_score(narsil_workspace *workspace, const narsil_store *store, const narsil_score_request *request,
                           double *distances);

narsil_status narsil_place(narsil_workspace *workspace, const narsil_graph *graph, const narsil_store *store,
                           const narsil_place_request *request);

narsil_status narsil_remove(const narsil_graph *graph, const narsil_remove_request *request);

narsil_status narsil_compact(narsil_workspace *workspace, const narsil_graph *graph, const narsil_store *store,
                             const narsil_compact_request *request);

narsil_status narsil_calibrate(narsil_workspace *workspace, const narsil_store *store,
                               const narsil_ordinals_request *request);

narsil_status narsil_quantise(narsil_workspace *workspace, const narsil_store *store,
                              const narsil_ordinals_request *request);

#ifdef __cplusplus
}
#endif

#endif
