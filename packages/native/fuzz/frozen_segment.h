#ifndef NARSIL_FUZZ_FROZEN_SEGMENT_H
#define NARSIL_FUZZ_FROZEN_SEGMENT_H

#include "input.h"

#include "../include/narsil_expansion.h"
#include "../include/narsil_frozen_segments.h"

#include <stddef.h>
#include <stdint.h>

enum {
  FUZZ_FROZEN_MAX_TERMS = 12,
  FUZZ_FROZEN_MAX_LIST_DOCUMENTS = 6,
  FUZZ_FROZEN_MAX_FIELDS = 3,
  FUZZ_FROZEN_MAX_ROWS = FUZZ_FROZEN_MAX_TERMS * FUZZ_FROZEN_MAX_LIST_DOCUMENTS * FUZZ_FROZEN_MAX_FIELDS,
  FUZZ_FROZEN_MAX_WORD_UNITS = 6,
  FUZZ_FROZEN_MAX_SPELLINGS = FUZZ_FROZEN_MAX_TERMS * 2
};

typedef struct {
  uint16_t units[FUZZ_FROZEN_MAX_WORD_UNITS];
  uint32_t length;
} fuzz_frozen_word;

typedef struct {
  narsil_frozen_segment segment;
  narsil_frozen_strings surfaces;
  narsil_frozen_strings spellings;
  narsil_frozen_strings paired_spellings;
  narsil_frozen_removal_index removal_index;
  narsil_frozen_segment_state state;
  narsil_frozen_runs runs;
  const uint32_t *position_offsets;
  const uint32_t *position_values;
  size_t position_count;
  const double *occurrences;
  const uint8_t *removal_file;
  size_t removal_file_bytes;
  size_t removal_offset_bytes;
  fuzz_frozen_word terms[FUZZ_FROZEN_MAX_TERMS];
  fuzz_frozen_word spelling_words[FUZZ_FROZEN_MAX_SPELLINGS];
  uint32_t spelling_terms[FUZZ_FROZEN_MAX_SPELLINGS];
  size_t spelling_count;
  uint32_t row_documents[FUZZ_FROZEN_MAX_ROWS];
  uint32_t row_terms[FUZZ_FROZEN_MAX_ROWS];
  uint16_t row_fields[FUZZ_FROZEN_MAX_ROWS];
  uint16_t row_frequencies[FUZZ_FROZEN_MAX_ROWS];
  uint32_t slot_starts[FUZZ_FROZEN_MAX_TERMS + 1];
  size_t row_count;
} fuzz_frozen;

fuzz_frozen *fuzz_frozen_create(fuzz_input *input);

#endif
