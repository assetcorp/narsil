#include "unicode.h"

#include "../../include/narsil_core.h"
#include "../thread_yield.h"

#include <stdatomic.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

#define BMP_SIZE 0x10000U
#define RUN_INDEX_MASK ((1U << NARSIL_UNICODE_RUN_INDEX_BITS) - 1U)
#define DECOMPOSITION_STRIDE 3U
#define SPECIAL_LOWERCASE_STRIDE 3U
#define LOWERCASE_STRIDE 2U
#define COMPOSITION_SECOND_BITS 21U

#define HANGUL_SYLLABLE_FIRST 0xAC00U
#define HANGUL_LEADING_FIRST 0x1100U
#define HANGUL_VOWEL_FIRST 0x1161U
#define HANGUL_TRAILING_BEFORE_FIRST 0x11A7U
#define HANGUL_LEADING_COUNT 19U
#define HANGUL_VOWEL_COUNT 21U
#define HANGUL_TRAILING_COUNT 28U
#define HANGUL_SYLLABLES_PER_LEADING (HANGUL_VOWEL_COUNT * HANGUL_TRAILING_COUNT)
#define HANGUL_SYLLABLE_COUNT (HANGUL_LEADING_COUNT * HANGUL_SYLLABLES_PER_LEADING)

enum { PREPARE_IDLE = 0, PREPARE_BUILDING = 1, PREPARE_READY = 2 };

typedef struct {
  uint64_t key;
  uint32_t composite;
} composition_entry;

static atomic_int prepare_state = PREPARE_IDLE;
static uint8_t bmp_value_index[BMP_SIZE];
static uint32_t *supplementary_starts;
static const uint32_t *supplementary_runs;
static uint32_t supplementary_run_count;
static composition_entry *compositions;
static uint32_t composition_count;

static uint64_t composition_key(uint32_t first, uint32_t second) {
  return ((uint64_t)first << COMPOSITION_SECOND_BITS) | second;
}

static int compare_compositions(const void *lhs, const void *rhs) {
  const composition_entry *left = lhs;
  const composition_entry *right = rhs;
  return (left->key > right->key) - (left->key < right->key);
}

static int build_property_index(void) {
  uint32_t start = 0;
  uint32_t first_supplementary = narsil_unicode_property_runs_length;
  for (uint32_t run = 0; run < narsil_unicode_property_runs_length; run++) {
    uint32_t length = narsil_unicode_property_runs[run] >> NARSIL_UNICODE_RUN_INDEX_BITS;
    uint32_t end = start + length;
    for (uint32_t code_point = start; code_point < end && code_point < BMP_SIZE; code_point++) {
      bmp_value_index[code_point] = (uint8_t)(narsil_unicode_property_runs[run] & RUN_INDEX_MASK);
    }
    if (end > BMP_SIZE && first_supplementary == narsil_unicode_property_runs_length) { first_supplementary = run; }
    start = end;
  }
  supplementary_run_count = narsil_unicode_property_runs_length - first_supplementary;
  if (supplementary_run_count == 0) { return NARSIL_OK; }
  supplementary_starts = malloc((size_t)supplementary_run_count * sizeof(uint32_t));
  if (supplementary_starts == NULL) { return NARSIL_OUT_OF_MEMORY; }
  supplementary_runs = &narsil_unicode_property_runs[first_supplementary];
  start = 0;
  for (uint32_t run = 0; run < narsil_unicode_property_runs_length; run++) {
    if (run >= first_supplementary) { supplementary_starts[run - first_supplementary] = start; }
    start += narsil_unicode_property_runs[run] >> NARSIL_UNICODE_RUN_INDEX_BITS;
  }
  return NARSIL_OK;
}

static int build_compositions(void) {
  uint32_t entries = narsil_unicode_decompositions_length / DECOMPOSITION_STRIDE;
  composition_count = 0;
  if (entries == 0) { return NARSIL_OK; }
  compositions = malloc((size_t)entries * sizeof(composition_entry));
  if (compositions == NULL) { return NARSIL_OUT_OF_MEMORY; }
  for (uint32_t entry = 0; entry < entries; entry++) {
    const uint32_t *row = &narsil_unicode_decompositions[(size_t)entry * DECOMPOSITION_STRIDE];
    if (row[2] == 0 || (narsil_unicode_properties(row[0]) & NARSIL_UNICODE_COMPOSITION_EXCLUDED) != 0) { continue; }
    compositions[composition_count].key = composition_key(row[1], row[2]);
    compositions[composition_count].composite = row[0];
    composition_count++;
  }
  qsort(compositions, composition_count, sizeof(composition_entry), compare_compositions);
  return NARSIL_OK;
}

static void release_tables(void) {
  free(supplementary_starts);
  supplementary_starts = NULL;
  free(compositions);
  compositions = NULL;
}

int narsil_unicode_prepare(void) {
  for (;;) {
    int state = atomic_load_explicit(&prepare_state, memory_order_acquire);
    if (state == PREPARE_READY) { return NARSIL_OK; }
    if (state == PREPARE_IDLE && atomic_compare_exchange_strong_explicit(&prepare_state, &state, PREPARE_BUILDING,
                                                                         memory_order_acq_rel, memory_order_acquire)) {
      break;
    }
    if (state == PREPARE_BUILDING) { narsil_yield_thread(); }
  }
  int status = build_property_index();
  if (status == NARSIL_OK) { status = build_compositions(); }
  if (status == NARSIL_OK) {
    atomic_store_explicit(&prepare_state, PREPARE_READY, memory_order_release);
    return NARSIL_OK;
  }
  release_tables();
  atomic_store_explicit(&prepare_state, PREPARE_IDLE, memory_order_release);
  return status;
}

uint32_t narsil_unicode_properties(uint32_t code_point) {
  if (code_point < BMP_SIZE) { return narsil_unicode_property_values[bmp_value_index[code_point]]; }
  if (code_point > NARSIL_UNICODE_MAX_CODE_POINT || supplementary_run_count == 0) { return 0; }
  uint32_t low = 0;
  uint32_t high = supplementary_run_count;
  while (high - low > 1) {
    uint32_t middle = low + ((high - low) / 2);
    if (supplementary_starts[middle] <= code_point) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return narsil_unicode_property_values[supplementary_runs[low] & RUN_INDEX_MASK];
}

uint32_t narsil_unicode_combining_class(uint32_t code_point) {
  return narsil_unicode_properties(code_point) & NARSIL_UNICODE_COMBINING_CLASS_MASK;
}

uint32_t narsil_unicode_script(uint32_t code_point) {
  return (narsil_unicode_properties(code_point) >> NARSIL_UNICODE_SCRIPT_SHIFT) & NARSIL_UNICODE_SCRIPT_MASK;
}

typedef struct {
  const uint32_t *rows;
  uint32_t length;
  uint32_t stride;
} row_table;

static const uint32_t *find_row(row_table table, uint32_t code_point) {
  size_t low = 0;
  size_t high = table.length / table.stride;
  while (low < high) {
    size_t middle = low + ((high - low) / 2);
    const uint32_t *row = &table.rows[middle * table.stride];
    if (row[0] == code_point) { return row; }
    if (row[0] < code_point) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return NULL;
}

uint32_t narsil_unicode_lowercase_of(uint32_t code_point, uint32_t *second) {
  *second = 0;
  if ((narsil_unicode_properties(code_point) & NARSIL_UNICODE_LOWERCASE_MAPPING) == 0) { return code_point; }
  row_table special_table = {narsil_unicode_special_lowercase, narsil_unicode_special_lowercase_length,
                             SPECIAL_LOWERCASE_STRIDE};
  const uint32_t *special = find_row(special_table, code_point);
  if (special != NULL) {
    *second = special[2];
    return special[1];
  }
  row_table pair_table = {narsil_unicode_lowercase, narsil_unicode_lowercase_length, LOWERCASE_STRIDE};
  const uint32_t *pair = find_row(pair_table, code_point);
  return pair == NULL ? code_point : pair[1];
}

static const uint32_t *decomposition_of(uint32_t code_point) {
  if ((narsil_unicode_properties(code_point) & NARSIL_UNICODE_DECOMPOSES) == 0) { return NULL; }
  row_table table = {narsil_unicode_decompositions, narsil_unicode_decompositions_length, DECOMPOSITION_STRIDE};
  return find_row(table, code_point);
}

static uint32_t decompose_fully(uint32_t code_point, uint32_t *out) {
  uint32_t pending[NARSIL_UNICODE_MAX_DECOMPOSITION];
  uint32_t pending_count = 1;
  uint32_t written = 0;
  pending[0] = code_point;
  while (pending_count > 0 && written < NARSIL_UNICODE_MAX_DECOMPOSITION) {
    uint32_t current = pending[--pending_count];
    const uint32_t *row = decomposition_of(current);
    if (row == NULL || pending_count + 2 > NARSIL_UNICODE_MAX_DECOMPOSITION) {
      out[written++] = current;
      continue;
    }
    if (row[2] != 0) { pending[pending_count++] = row[2]; }
    pending[pending_count++] = row[1];
  }
  return written;
}

uint32_t narsil_unicode_decompose(uint32_t code_point, uint32_t *out) {
  if (code_point >= HANGUL_SYLLABLE_FIRST && code_point < HANGUL_SYLLABLE_FIRST + HANGUL_SYLLABLE_COUNT) {
    uint32_t index = code_point - HANGUL_SYLLABLE_FIRST;
    uint32_t trailing = index % HANGUL_TRAILING_COUNT;
    out[0] = HANGUL_LEADING_FIRST + (index / HANGUL_SYLLABLES_PER_LEADING);
    out[1] = HANGUL_VOWEL_FIRST + ((index % HANGUL_SYLLABLES_PER_LEADING) / HANGUL_TRAILING_COUNT);
    if (trailing == 0) { return 2; }
    out[2] = HANGUL_TRAILING_BEFORE_FIRST + trailing;
    return 3;
  }
  return decompose_fully(code_point, out);
}

static uint32_t compose_hangul(uint32_t first, uint32_t second) {
  if (first >= HANGUL_LEADING_FIRST && first < HANGUL_LEADING_FIRST + HANGUL_LEADING_COUNT &&
      second >= HANGUL_VOWEL_FIRST && second < HANGUL_VOWEL_FIRST + HANGUL_VOWEL_COUNT) {
    return HANGUL_SYLLABLE_FIRST + ((first - HANGUL_LEADING_FIRST) * HANGUL_SYLLABLES_PER_LEADING) +
           ((second - HANGUL_VOWEL_FIRST) * HANGUL_TRAILING_COUNT);
  }
  if (first >= HANGUL_SYLLABLE_FIRST && first < HANGUL_SYLLABLE_FIRST + HANGUL_SYLLABLE_COUNT &&
      (first - HANGUL_SYLLABLE_FIRST) % HANGUL_TRAILING_COUNT == 0 && second > HANGUL_TRAILING_BEFORE_FIRST &&
      second < HANGUL_TRAILING_BEFORE_FIRST + HANGUL_TRAILING_COUNT) {
    return first + (second - HANGUL_TRAILING_BEFORE_FIRST);
  }
  return NARSIL_UNICODE_NO_COMPOSITE;
}

uint32_t narsil_unicode_compose(uint32_t first, uint32_t second) {
  uint32_t hangul = compose_hangul(first, second);
  if (hangul != NARSIL_UNICODE_NO_COMPOSITE) { return hangul; }
  if ((narsil_unicode_properties(second) & NARSIL_UNICODE_COMPOSES_SECOND) == 0) { return NARSIL_UNICODE_NO_COMPOSITE; }
  uint64_t key = composition_key(first, second);
  uint32_t low = 0;
  uint32_t high = composition_count;
  while (low < high) {
    uint32_t middle = low + ((high - low) / 2);
    if (compositions[middle].key == key) { return compositions[middle].composite; }
    if (compositions[middle].key < key) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return NARSIL_UNICODE_NO_COMPOSITE;
}
