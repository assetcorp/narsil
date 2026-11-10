#ifndef NARSIL_FUZZ_SEGMENT_H
#define NARSIL_FUZZ_SEGMENT_H

#include "input.h"

#include "../include/narsil_segments.h"

#include <stddef.h>
#include <stdint.h>

typedef struct {
  narsil_growing_segment segment;
  narsil_position_pool positions;
  narsil_surface_table surfaces;
  narsil_spelling_table spellings;
  int large;
} fuzz_growing;

fuzz_growing *fuzz_growing_create(fuzz_input *input);
void fuzz_growing_disturb(fuzz_input *input, fuzz_growing *growing);
narsil_field_tokens *fuzz_fields(fuzz_input *input, uint32_t field_count, size_t *count);
uint16_t *fuzz_word(fuzz_input *input, size_t *length);

#endif
