#include "input.h"
#include "stored_values.h"

#include "../include/narsil_core.h"
#include "../include/narsil_pattern.h"
#include "../include/narsil_stored_values.h"
#include "../include/narsil_work.h"

#include <stddef.h>
#include <stdint.h>

enum {
  MAX_DOCUMENTS = 64,
  MAX_LIST_ENTRIES = 256,
  MAX_RUNS = 64,
  OPERATOR_CHOICES = NARSIL_PATTERN_REGEX + 2,
  FLAG_CHOICES = 3,
  TOLERANCE_CHOICES = 5,
  RUN_POINTS = 3,
  MAX_QUERY_UNITS = 64,
  MAX_MATCHER_BYTES = 1U << 20
};

static narsil_pattern_list fuzz_list(fuzz_input *input, size_t count) {
  return (narsil_pattern_list){FUZZ_ARRAY(input, uint32_t, count), count};
}

static narsil_pattern_index fuzz_index(fuzz_input *input, uint32_t document_count) {
  size_t runs = fuzz_below(input, MAX_RUNS + 1);
  size_t run_words = runs * RUN_POINTS;
  size_t offsets = runs + 1;
  int raw = (fuzz_byte(input) & 1U) != 0;
  if (raw) {
    run_words = fuzz_below(input, MAX_LIST_ENTRIES + 1);
    offsets = fuzz_below(input, MAX_LIST_ENTRIES + 1);
  }
  size_t document_entries = fuzz_below(input, MAX_LIST_ENTRIES + 1);
  uint32_t *ordinals = FUZZ_ARRAY(input, uint32_t, document_entries);
  for (size_t at = 0; !raw && ordinals != NULL && at < document_entries; at++) { ordinals[at] %= document_count + 1; }
  narsil_pattern_list documents = {ordinals, document_entries};
  narsil_pattern_list run_list = fuzz_list(input, run_words);
  narsil_pattern_list offset_list = fuzz_list(input, offsets);
  return (narsil_pattern_index){documents, run_list, offset_list,
                                fuzz_list(input, fuzz_below(input, MAX_LIST_ENTRIES + 1))};
}

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  narsil_workspace *workspace = NULL;
  if (narsil_workspace_create(&workspace) != NARSIL_OK) { return 0; }
  fuzz_input input = fuzz_begin(data, size);
  uint32_t documents = fuzz_below(&input, MAX_DOCUMENTS + 1);
  size_t query_length = fuzz_below(&input, MAX_QUERY_UNITS + 1);
  narsil_pattern_test test = {FUZZ_ARRAY(&input, uint16_t, query_length),
                              query_length,
                              fuzz_below(&input, OPERATOR_CHOICES),
                              fuzz_below(&input, FLAG_CHOICES),
                              (fuzz_byte(&input) & 1U) == 0 ? 0 : fuzz_below(&input, TOLERANCE_CHOICES),
                              fuzz_below(&input, FLAG_CHOICES),
                              fuzz_below(&input, MAX_MATCHER_BYTES)};
  narsil_pattern_index index = fuzz_index(&input, documents);
  narsil_stored_values values = fuzz_stored_values(&input, documents);
  fuzz_meter_state state;
  narsil_work_meter meter = fuzz_meter(&input, &state);
  size_t into_words = 0;
  uint32_t *into = fuzz_bits(&input, documents, &into_words);
  if (!input.exhausted_memory) {
    (void)narsil_pattern_match(workspace, &index, &values, &test, &meter, into, into_words);
  }
  narsil_workspace_destroy(workspace);
  fuzz_release(&input);
  return 0;
}
