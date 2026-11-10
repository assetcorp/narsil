#ifndef NARSIL_NODE_TERMS_H
#define NARSIL_NODE_TERMS_H

#include "../include/narsil_terms.h"

#include <js_native_api_types.h>

enum { TERM_HANDLES = 7, DICTIONARY_HANDLES = 4 };

typedef struct {
  napi_value table[TERM_HANDLES];
  napi_value dictionary[DICTIONARY_HANDLES];
  int growing;
} term_handles;

int prepare_term_dictionary(napi_env env, napi_value value, term_handles *handles);
int prepare_term_table(napi_env env, napi_value value, napi_value handles[TERM_HANDLES]);
int read_term_table(napi_env env, const napi_value handles[TERM_HANDLES], narsil_term_table *table);
int read_term_dictionary(napi_env env, const term_handles *handles, narsil_term_table *table,
                         narsil_term_dictionary *dictionary);
int define_terms(napi_env env, napi_value exports);

#endif
