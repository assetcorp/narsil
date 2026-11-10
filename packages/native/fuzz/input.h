#ifndef NARSIL_FUZZ_INPUT_H
#define NARSIL_FUZZ_INPUT_H

#include "../include/narsil_work.h"

#include <stddef.h>
#include <stdint.h>

#define FUZZ_MAX_HELD 1024U

typedef struct {
  int64_t spent;
  uint32_t stop;
} fuzz_meter_state;

typedef struct {
  const uint8_t *data;
  size_t size;
  void *held[FUZZ_MAX_HELD];
  size_t held_count;
  int exhausted_memory;
} fuzz_input;

typedef struct {
  size_t count;
  uint32_t limit;
} fuzz_span;

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size);

fuzz_input fuzz_begin(const uint8_t *data, size_t size);
uint8_t fuzz_byte(fuzz_input *input);
uint32_t fuzz_u32(fuzz_input *input);
uint64_t fuzz_u64(fuzz_input *input);
uint32_t fuzz_below(fuzz_input *input, uint32_t limit);
int fuzz_raw(fuzz_input *input);
size_t fuzz_count(fuzz_input *input, size_t limit);
void fuzz_store_u32(uint8_t *bytes, uint32_t value);
size_t fuzz_bit_bytes(size_t bits);
size_t fuzz_bit_words(size_t bits);
size_t fuzz_nonempty_bit_words(size_t bits);
uint32_t *fuzz_bits(fuzz_input *input, uint32_t documents, size_t *words);
uint32_t *fuzz_below_each(fuzz_input *input, fuzz_span span);
void fuzz_ascend(uint32_t *values, fuzz_span span);
uint32_t *fuzz_offsets(fuzz_input *input, size_t count, uint32_t total);
double fuzz_double(fuzz_input *input);
double fuzz_number(fuzz_input *input);
double *fuzz_numbers(fuzz_input *input, size_t count);
void *fuzz_array(fuzz_input *input, size_t count, size_t element);
void *fuzz_room(fuzz_input *input, size_t count, size_t element);
void *fuzz_zeroed(fuzz_input *input, size_t count, size_t element);
void fuzz_disturb(fuzz_input *input, void *region, size_t bytes);
narsil_work_meter fuzz_meter(fuzz_input *input, fuzz_meter_state *state);
void fuzz_release(fuzz_input *input);

#define FUZZ_ARRAY(input, type, count) ((type *)fuzz_array((input), (count), sizeof(type)))
#define FUZZ_ROOM(input, type, count) ((type *)fuzz_room((input), (count), sizeof(type)))
#define FUZZ_ZEROED(input, type, count) ((type *)fuzz_zeroed((input), (count), sizeof(type)))

#endif
