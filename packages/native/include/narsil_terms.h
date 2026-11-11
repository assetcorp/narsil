#ifndef NARSIL_TERMS_H
#define NARSIL_TERMS_H

#include "narsil_core.h"

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  uint32_t *header;
  size_t header_words;
  int32_t *slots;
  size_t slot_count;
  uint32_t *term_offset;
  size_t offset_count;
  uint32_t *term_length;
  size_t length_count;
  uint32_t *first_unit_next;
  size_t next_count;
  uint32_t *first_unit_head;
  size_t head_count;
  uint16_t *units;
  size_t unit_count;
} narsil_term_table;

typedef struct {
  const narsil_term_table *growing;
  const uint8_t *tokens;
  size_t token_bytes;
  const uint32_t *offsets;
  size_t offset_count;
  const uint32_t *frequencies;
  size_t frequency_count;
  const uint32_t *removed;
  size_t removed_count;
  const int32_t *exact_slots;
  size_t exact_slot_count;
} narsil_term_dictionary;

enum { NARSIL_LOOKUP_EXACT, NARSIL_LOOKUP_PREFIX, NARSIL_LOOKUP_TYPO };

typedef struct {
  const narsil_term_dictionary *dictionary;
  const uint16_t *text;
  size_t text_length;
  uint32_t operation;
  uint32_t limit;
  uint32_t tolerance;
  uint32_t prefix_length;
} narsil_term_lookup;

narsil_status narsil_lookup_terms(narsil_workspace *workspace, const narsil_term_lookup *request, uint32_t *ordinals,
                                  size_t capacity, uint32_t *count);
narsil_status narsil_lookup_exact_batch(narsil_workspace *workspace, const narsil_term_dictionary *dictionary,
                                        const uint16_t *units, size_t unit_count, const uint32_t *offsets,
                                        size_t offset_count, uint32_t *ordinals, size_t capacity);
narsil_status narsil_build_exact_terms(const narsil_term_dictionary *dictionary, int32_t *slots, size_t slot_count);
narsil_status narsil_document_frequency(const narsil_term_dictionary *dictionary, uint32_t token, uint32_t *frequency,
                                        size_t capacity);

#ifdef __cplusplus
}
#endif

#endif
