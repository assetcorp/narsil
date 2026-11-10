#ifndef NARSIL_TEST_SEGMENT_FIXTURE_H
#define NARSIL_TEST_SEGMENT_FIXTURE_H

#include "../include/narsil_segments.h"

#include <stdint.h>

enum {
  TERMS = 2048,
  SLOTS = 4096,
  UNITS = 32768,
  HEADS = 65536,
  POOL = 4096,
  POSITIONS = 8192,
  CLASSES = 12,
  ORDINALS = 2048,
  FIELDS = 2,
  RUNS = 2048,
  RUN_SLOTS = 4096,
  RUN_MEMBERS = 32768
};

enum { HEADER_WORDS = 8, WORD_BITS = 32 };

typedef struct {
  uint32_t header[HEADER_WORDS];
  int32_t slots[SLOTS];
  uint32_t offsets[TERMS];
  uint32_t lengths[TERMS];
  uint32_t next[TERMS];
  uint32_t heads[HEADS];
  uint16_t units[UNITS];
} test_strings;

typedef struct {
  test_strings terms;
  test_strings surfaces;
  test_strings spellings;
  uint32_t surface_tokens[TERMS];
  uint32_t surface_counts[TERMS];
  uint32_t spelling_tokens[TERMS];
  uint32_t spelling_counts[TERMS];
  uint32_t spelling_points[TERMS];
  uint32_t starts[TERMS];
  uint8_t classes[TERMS];
  uint32_t lengths[TERMS];
  uint32_t frequencies[TERMS];
  uint32_t dead[TERMS];
  double occurrences[TERMS];
  double surface_occurrences[TERMS];
  uint32_t revisions[TERMS];
  uint8_t flags[TERMS];
  uint32_t docs[POOL];
  uint16_t counts[POOL];
  uint16_t fields[POOL];
  uint32_t positions_at[POOL];
  uint32_t posting_allocation[2];
  uint32_t posting_free[CLASSES];
  uint32_t sizes[CLASSES];
  uint32_t positions[POSITIONS];
  uint32_t position_allocation[2];
  uint32_t retired[ORDINALS / WORD_BITS];
  uint32_t field_lengths[ORDINALS * FIELDS];
  uint32_t documents;
  double total_lengths[FIELDS];
  uint8_t partial[FIELDS];
  uint32_t run_header[HEADER_WORDS];
  int32_t run_slots[RUN_SLOTS];
  uint32_t runs[RUNS * 3];
  uint32_t run_starts[RUNS];
  uint32_t run_lengths[RUNS];
  uint8_t run_classes[RUNS];
  uint32_t members[RUN_MEMBERS];
  uint32_t run_allocation[2];
  uint32_t run_free[CLASSES];
  narsil_surface_table surface_table;
  narsil_spelling_table spelling_table;
  narsil_position_pool position_pool;
  narsil_growing_segment segment;
} segment_fixture;

segment_fixture *create_segment_fixture(void);

#endif
