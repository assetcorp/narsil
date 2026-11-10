#include "input.h"

#include "../include/narsil_work.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define BYTE_BITS 8U
#define WORD_BITS 32U
#define OUTPUT_FILL 0xA5
#define STOP_CHOICES 16U
#define CAP_CHOICES 8U
#define MAX_SMALL_CAP 4096U
#define NUMBER_CHOICES 4U
#define SMALL_NUMBER_SCALES 4U
#define RAW_SHAPE_CHOICES 8U
#define MAX_DISTURBED_BYTES 6U
#define EMPTY_REGION_BYTES 1U

fuzz_input fuzz_begin(const uint8_t *data, size_t size) {
  fuzz_input input;
  memset(&input, 0, sizeof input);
  input.data = data;
  input.size = size;
  return input;
}

uint8_t fuzz_byte(fuzz_input *input) {
  if (input->size == 0) { return 0; }
  uint8_t byte = input->data[0];
  input->data++;
  input->size--;
  return byte;
}

uint32_t fuzz_u32(fuzz_input *input) {
  uint32_t value = 0;
  for (uint32_t at = 0; at < sizeof value; at++) { value |= (uint32_t)fuzz_byte(input) << (at * BYTE_BITS); }
  return value;
}

uint64_t fuzz_u64(fuzz_input *input) {
  uint64_t low = fuzz_u32(input);
  return low | ((uint64_t)fuzz_u32(input) << (sizeof(uint32_t) * BYTE_BITS));
}

uint32_t fuzz_below(fuzz_input *input, uint32_t limit) { return limit == 0 ? 0 : fuzz_u32(input) % limit; }

int fuzz_raw(fuzz_input *input) { return fuzz_byte(input) % RAW_SHAPE_CHOICES == 0; }

size_t fuzz_count(fuzz_input *input, size_t limit) { return fuzz_below(input, (uint32_t)limit + 1); }

void fuzz_store_u32(uint8_t *bytes, uint32_t value) {
  for (uint32_t at = 0; at < sizeof value; at++) { bytes[at] = (uint8_t)(value >> (at * BYTE_BITS)); }
}

size_t fuzz_bit_bytes(size_t bits) { return (bits / BYTE_BITS) + (bits % BYTE_BITS != 0); }

size_t fuzz_bit_words(size_t bits) { return (bits / WORD_BITS) + (bits % WORD_BITS != 0); }

size_t fuzz_nonempty_bit_words(size_t bits) { return bits == 0 ? 1 : fuzz_bit_words(bits); }

uint32_t *fuzz_bits(fuzz_input *input, uint32_t documents, size_t *words) {
  size_t needed = fuzz_bit_words(documents);
  *words = (fuzz_byte(input) & 1U) == 0 ? needed : fuzz_count(input, needed + 1);
  return FUZZ_ARRAY(input, uint32_t, *words);
}

uint32_t *fuzz_below_each(fuzz_input *input, fuzz_span span) {
  uint32_t *values = FUZZ_ARRAY(input, uint32_t, span.count);
  if (values == NULL || fuzz_raw(input)) { return values; }
  for (size_t at = 0; at < span.count; at++) { values[at] = span.limit == 0 ? 0 : values[at] % span.limit; }
  return values;
}

void fuzz_ascend(uint32_t *values, fuzz_span span) {
  uint32_t floor = 0;
  for (size_t at = 0; at < span.count; at++) {
    floor += (uint32_t)(values[at] % ((uint64_t)(span.limit - floor) + 1));
    values[at] = floor;
  }
}

uint32_t *fuzz_offsets(fuzz_input *input, size_t count, uint32_t total) {
  if (count == SIZE_MAX) {
    input->exhausted_memory = 1;
    return NULL;
  }
  uint32_t *offsets = FUZZ_ARRAY(input, uint32_t, count + 1);
  if (offsets == NULL || fuzz_raw(input)) { return offsets; }
  for (size_t at = 0; at <= count; at++) {
    uint32_t value = (uint32_t)((uint64_t)offsets[at] % ((uint64_t)total + 1));
    size_t place = at;
    while (place > 0 && offsets[place - 1] > value) {
      offsets[place] = offsets[place - 1];
      place--;
    }
    offsets[place] = value;
  }
  offsets[0] = 0;
  offsets[count] = total;
  return offsets;
}

double fuzz_double(fuzz_input *input) {
  uint64_t bits = fuzz_u64(input);
  double value = 0;
  memcpy(&value, &bits, sizeof value);
  return value;
}

double fuzz_number(fuzz_input *input) {
  uint8_t mode = fuzz_byte(input);
  if (mode % NUMBER_CHOICES == 0) { return fuzz_double(input); }
  return (double)(int8_t)fuzz_byte(input) / (double)(1U << (mode % SMALL_NUMBER_SCALES));
}

double *fuzz_numbers(fuzz_input *input, size_t count) {
  double *numbers = fuzz_room(input, count, sizeof *numbers);
  for (size_t at = 0; numbers != NULL && at < count; at++) { numbers[at] = fuzz_number(input); }
  return numbers;
}

static void *hold(fuzz_input *input, size_t count, size_t element) {
  if (element == 0 || count > SIZE_MAX / element) {
    input->exhausted_memory = 1;
    return NULL;
  }
  if (input->held_count == FUZZ_MAX_HELD) {
    input->exhausted_memory = 1;
    return NULL;
  }
  uint8_t *bytes = malloc(count == 0 ? EMPTY_REGION_BYTES : count * element);
  if (bytes == NULL) {
    input->exhausted_memory = 1;
    return NULL;
  }
  input->held[input->held_count++] = bytes;
  return count == 0 ? bytes + EMPTY_REGION_BYTES : bytes;
}

void *fuzz_array(fuzz_input *input, size_t count, size_t element) {
  uint8_t *bytes = hold(input, count, element);
  if (bytes == NULL) { return NULL; }
  size_t length = count * element;
  size_t taken = length < input->size ? length : input->size;
  if (taken > 0) { memcpy(bytes, input->data, taken); }
  if (length > taken) { memset(bytes + taken, 0, length - taken); }
  input->data += taken;
  input->size -= taken;
  return bytes;
}

void *fuzz_room(fuzz_input *input, size_t count, size_t element) {
  uint8_t *bytes = hold(input, count, element);
  if (bytes != NULL && count * element > 0) { memset(bytes, OUTPUT_FILL, count * element); }
  return bytes;
}

void *fuzz_zeroed(fuzz_input *input, size_t count, size_t element) {
  uint8_t *bytes = hold(input, count, element);
  if (bytes != NULL && count * element > 0) { memset(bytes, 0, count * element); }
  return bytes;
}

void fuzz_disturb(fuzz_input *input, void *region, size_t bytes) {
  uint8_t *target = region;
  uint32_t changes = fuzz_raw(input) ? 1 + fuzz_below(input, MAX_DISTURBED_BYTES) : 0;
  for (uint32_t change = 0; target != NULL && bytes > 0 && bytes <= UINT32_MAX && change < changes; change++) {
    target[fuzz_below(input, (uint32_t)bytes)] ^= (uint8_t)(fuzz_byte(input) | 1U);
  }
}

narsil_work_meter fuzz_meter(fuzz_input *input, fuzz_meter_state *state) {
  state->spent = 0;
  state->stop = fuzz_byte(input) % STOP_CHOICES == 0 ? 1 : 0;
  int64_t cap = fuzz_byte(input) % CAP_CHOICES == 0 ? (int64_t)fuzz_below(input, MAX_SMALL_CAP) : INT64_MAX;
  return (narsil_work_meter){&state->spent, cap, &state->stop, 0};
}

void fuzz_release(fuzz_input *input) {
  for (size_t at = 0; at < input->held_count; at++) { free(input->held[at]); }
  input->held_count = 0;
}
