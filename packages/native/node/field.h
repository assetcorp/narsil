#ifndef NARSIL_NODE_FIELD_H
#define NARSIL_NODE_FIELD_H

#include "../include/narsil_core.h"

#include <js_native_api_types.h>
#include <stdint.h>

typedef struct {
  narsil_graph graph;
  narsil_store store;
  const uint8_t **code_blocks;
  const float **vector_blocks;
  napi_ref memory;
} attached_field;

attached_field *read_field(napi_env env, napi_value memory);
void release_field(napi_env env, void *finalize_data, void *finalize_hint);

#endif
