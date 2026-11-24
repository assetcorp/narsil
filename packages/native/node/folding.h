#ifndef NARSIL_NODE_FOLDING_H
#define NARSIL_NODE_FOLDING_H

#include "../include/narsil_expansion.h"
#include "../include/narsil_folding.h"
#include "values.h"

#include <js_native_api_types.h>
#include <stdint.h>

int folded_array_length(napi_env env, napi_value value, uint32_t *length);
narsil_status hold_fold_tables(napi_env env, thread_state *thread, napi_value tables, uint32_t count,
                               const narsil_expansion_segment *segments, uint32_t language,
                               const narsil_fold_table **held);
napi_value expand_folded_partial_words(napi_env env, napi_callback_info info);

#endif
