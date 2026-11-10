#ifndef NARSIL_NODE_HIGHLIGHT_H
#define NARSIL_NODE_HIGHLIGHT_H

#include "../include/narsil_highlight.h"

#include <js_native_api_types.h>
#include <stdint.h>

typedef struct {
  napi_value prefix;
  napi_value *terms;
  napi_value *synonyms;
  napi_value *partial;
  narsil_highlight_term *term_values;
  narsil_highlight_text *synonym_values;
  narsil_highlight_text *partial_values;
  narsil_highlight_query query;
} highlight_handles;

int prepare_highlight_query(napi_env env, napi_value value, highlight_handles *handles);
int read_highlight_query(napi_env env, highlight_handles *handles);
void release_highlight_query(highlight_handles *handles);
int read_highlight_text(napi_env env, napi_value value, narsil_highlight_text *text);
int define_highlight(napi_env env, napi_value exports);

#endif
