#include "stored_values.h"

#include "input.h"

#include "../include/narsil_stored_values.h"

#include <stddef.h>
#include <stdint.h>

enum {
  MAX_VALUES_PER_DOCUMENT = 4,
  MAX_STORED_UNITS = 512,
  MAX_STORED_BYTES = 256,
  STORED_SHAPES = 3,
  STORED_KINDS = 6,
  STORED_STRING_KIND = 4,
  STORED_ABSENT_SHAPE = 0,
  STORED_SCALAR_SHAPE = 1,
  RAW_LAYOUT_CHOICES = 8,
  RAW_CONTENT_BIT = 8
};

static narsil_stored_values raw_values(fuzz_input *input, uint32_t documents) {
  size_t values = (size_t)documents * MAX_VALUES_PER_DOCUMENT;
  size_t shape_count = fuzz_count(input, documents);
  size_t start_count = fuzz_count(input, (size_t)documents + 1);
  size_t kind_count = fuzz_count(input, values);
  size_t number_count = fuzz_count(input, values);
  size_t text_start_count = fuzz_count(input, values);
  size_t text_length_count = fuzz_count(input, values);
  size_t unit_count = fuzz_count(input, MAX_STORED_UNITS);
  size_t byte_count = fuzz_count(input, MAX_STORED_BYTES);
  return (narsil_stored_values){FUZZ_ARRAY(input, uint8_t, shape_count),        shape_count,
                                FUZZ_ARRAY(input, uint32_t, start_count),       start_count,
                                FUZZ_ARRAY(input, uint8_t, kind_count),         kind_count,
                                FUZZ_ARRAY(input, double, number_count),        number_count,
                                FUZZ_ARRAY(input, uint32_t, text_start_count),  text_start_count,
                                FUZZ_ARRAY(input, uint32_t, text_length_count), text_length_count,
                                FUZZ_ARRAY(input, uint16_t, unit_count),        unit_count,
                                FUZZ_ARRAY(input, uint8_t, byte_count),         byte_count};
}

static uint32_t elements_of(uint8_t shape, uint32_t drawn) {
  if (shape == STORED_ABSENT_SHAPE) { return 0; }
  return shape == STORED_SCALAR_SHAPE ? 1 : drawn % (MAX_VALUES_PER_DOCUMENT + 1);
}

static void shape_documents(uint8_t *shapes, size_t shape_count, uint32_t *starts, size_t kind_count) {
  uint32_t used = 0;
  for (size_t at = 0; at < shape_count; at++) {
    shapes[at] %= STORED_SHAPES;
    uint32_t elements = elements_of(shapes[at], starts[at + 1]);
    if (elements > kind_count - used) {
      shapes[at] = STORED_ABSENT_SHAPE;
      elements = 0;
    }
    starts[at] = used;
    used += elements;
  }
  starts[shape_count] = used;
}

static void shape_elements(narsil_stored_values *values, uint8_t *kinds, uint32_t *text_start, uint32_t *text_length) {
  for (size_t at = 0; at < values->kind_count; at++) {
    kinds[at] %= STORED_KINDS;
    size_t capacity = kinds[at] == STORED_STRING_KIND ? values->unit_count : values->byte_count;
    text_start[at] %= (uint32_t)capacity + 1;
    text_length[at] %= (uint32_t)(capacity - text_start[at]) + 1;
  }
}

narsil_stored_values fuzz_stored_values(fuzz_input *input, uint32_t documents) {
  uint8_t mode = fuzz_byte(input);
  if (mode % RAW_LAYOUT_CHOICES == 0) { return raw_values(input, documents); }
  size_t shape_count = fuzz_count(input, documents);
  size_t kind_count = fuzz_count(input, (size_t)documents * MAX_VALUES_PER_DOCUMENT);
  size_t unit_count = fuzz_count(input, MAX_STORED_UNITS);
  size_t byte_count = fuzz_count(input, MAX_STORED_BYTES);
  uint8_t *shapes = FUZZ_ARRAY(input, uint8_t, shape_count);
  uint32_t *starts = FUZZ_ARRAY(input, uint32_t, shape_count + 1);
  uint8_t *kinds = FUZZ_ARRAY(input, uint8_t, kind_count);
  uint32_t *text_start = FUZZ_ARRAY(input, uint32_t, kind_count);
  uint32_t *text_length = FUZZ_ARRAY(input, uint32_t, kind_count);
  narsil_stored_values values = {shapes,
                                 shape_count,
                                 starts,
                                 shape_count + 1,
                                 kinds,
                                 kind_count,
                                 FUZZ_ARRAY(input, double, kind_count),
                                 kind_count,
                                 text_start,
                                 kind_count,
                                 text_length,
                                 kind_count,
                                 FUZZ_ARRAY(input, uint16_t, unit_count),
                                 unit_count,
                                 FUZZ_ARRAY(input, uint8_t, byte_count),
                                 byte_count};
  if (input->exhausted_memory || (mode & RAW_CONTENT_BIT) != 0 || starts == NULL) { return values; }
  if (shape_count > 0) { shape_documents(shapes, shape_count, starts, kind_count); }
  if (kind_count > 0) { shape_elements(&values, kinds, text_start, text_length); }
  return values;
}
