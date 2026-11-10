#ifndef NARSIL_STORED_VALUES_H
#define NARSIL_STORED_VALUES_H

#include <stddef.h>
#include <stdint.h>

typedef struct {
  const uint8_t *shapes;
  size_t shape_count;
  const uint32_t *starts;
  size_t start_count;
  const uint8_t *kinds;
  size_t kind_count;
  const double *numbers;
  size_t number_count;
  const uint32_t *text_start;
  size_t text_start_count;
  const uint32_t *text_length;
  size_t text_length_count;
  const uint16_t *units;
  size_t unit_count;
  const uint8_t *bytes;
  size_t byte_count;
} narsil_stored_values;

#endif
