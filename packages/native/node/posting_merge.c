#include "segment_merge.h"

#include "../include/narsil_posting_merge.h"
#include "segments.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <stddef.h>

enum { POSTING_OUTPUTS = 6 };
enum { DOCUMENTS, FREQUENCIES, FIELDS, OFFSETS, POSITIONS, TOTALS };

int prepare_posting_output(napi_env env, napi_value value, napi_value *handles) {
  const char *const keys[POSTING_OUTPUTS] = {"documents",       "frequencies", "fields",
                                             "positionOffsets", "positions",   "totals"};
  for (size_t at = 0; at < POSTING_OUTPUTS; at++) {
    if (napi_get_named_property(env, value, keys[at], handles + at) != napi_ok) { return 0; }
  }
  return 1;
}

int read_posting_output(napi_env env, const napi_value *handles, narsil_posting_merge_output *output) {
  const napi_typedarray_type types[POSTING_OUTPUTS] = {napi_uint32_array, napi_uint16_array, napi_uint16_array,
                                                       napi_uint32_array, napi_uint32_array, napi_float64_array};
  void *data[POSTING_OUTPUTS] = {0};
  size_t lengths[POSTING_OUTPUTS] = {0};
  if (!read_segment_arrays(env, handles, types, POSTING_OUTPUTS, data, lengths) || lengths[0] != lengths[1] ||
      lengths[0] != lengths[2]) {
    return 0;
  }
  *output = (narsil_posting_merge_output){data[DOCUMENTS], data[FREQUENCIES], data[FIELDS],    lengths[DOCUMENTS],
                                          data[OFFSETS],   lengths[OFFSETS],  data[POSITIONS], lengths[POSITIONS],
                                          data[TOTALS],    lengths[TOTALS]};
  return 1;
}
