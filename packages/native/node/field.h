#ifndef NARSIL_NODE_FIELD_H
#define NARSIL_NODE_FIELD_H

#include "../include/narsil_core.h"

#include <js_native_api_types.h>
#include <stdint.h>

#define WAKES_PER_CALL 256

typedef struct {
  int32_t ordinals[WAKES_PER_CALL];
  uint32_t count;
} pending_wakes;

#define ATTACHED_GRAPH_KIND 0x4E475248U
#define ATTACHED_STORE_KIND 0x4E535452U

typedef struct {
  uint32_t kind;
  narsil_graph graph;
  pending_wakes wakes;
  napi_ref memory;
  int64_t reported_bytes;
} attached_graph;

typedef struct {
  uint32_t kind;
  narsil_store store;
  void **code_blocks;
  void **vector_blocks;
  narsil_vector_file *files;
  napi_ref memory;
  int detached;
  int64_t reported_bytes;
} attached_store;

attached_graph *read_graph(napi_env env, napi_value memory);
attached_store *read_store(napi_env env, napi_value memory);
void detach_store(attached_store *attached);
void release_graph(napi_env env, void *finalize_data, void *finalize_hint);
void release_store(napi_env env, void *finalize_data, void *finalize_hint);

#endif
