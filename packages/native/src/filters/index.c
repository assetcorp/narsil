#include "../../include/narsil_core.h"
#include "../../include/narsil_filters.h"
#include "../allocation.h"
#include "../regions.h"
#include "constants.h"
#include "geo.h"
#include "internal.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

narsil_status reserve_filter_scratch(filter_scratch *scratch, size_t words) {
  if (words <= scratch->capacity) { return NARSIL_OK; }
  if (words > SIZE_MAX / sizeof *scratch->words) { return NARSIL_OUT_OF_MEMORY; }
  size_t capacity = scratch->capacity > 0 ? scratch->capacity : FILTER_INITIAL_WORDS;
  while (capacity < words) {
    if (capacity > SIZE_MAX / sizeof *scratch->words / 2) {
      capacity = words;
      break;
    }
    capacity *= 2;
  }
  uint32_t *held = core_reallocate(scratch->words, capacity * sizeof *held);
  if (held == NULL) { return NARSIL_OUT_OF_MEMORY; }
  scratch->words = held;
  scratch->capacity = capacity;
  return NARSIL_OK;
}

static void combine(uint32_t opcode, uint32_t *left, const uint32_t *right, size_t words) {
  for (size_t word = 0; word < words; word++) {
    if (opcode == NARSIL_FILTER_AND) {
      left[word] &= right[word];
    } else {
      left[word] |= right[word];
    }
  }
}

static void evaluate(const narsil_filter_program *program, filter_scratch *held, size_t depth) {
  uint32_t *stack = held->words;
  size_t words = program->live.count;
  uint32_t *temporary = stack + (depth * words);
  size_t count = 0;
  for (size_t at = 0; at < program->plan_words; at += 4) {
    uint32_t opcode = program->plan[at];
    uint32_t field = program->plan[at + 1];
    uint32_t operator = program->plan[at + 2];
    uint32_t operand = program->plan[at + 3];
    if (opcode == NARSIL_FILTER_TEST) {
      filter_test(program, &program->fields[field], operator, operand, stack + (count * words), temporary, &held->geo);
      count++;
    } else if (opcode == NARSIL_FILTER_BITSET || opcode == NARSIL_FILTER_PRESENT) {
      narsil_filter_bits source =
          opcode == NARSIL_FILTER_BITSET
              ? program->bitsets[operand]
              : (narsil_filter_bits){program->fields[field].regions[0].data, program->fields[field].regions[0].length};
      uint32_t *bits = stack + (count * words);
      size_t copied = source.count < words ? source.count : words;
      memcpy(bits, source.words, copied * sizeof *bits);
      memset(bits + copied, 0, (words - copied) * sizeof *bits);
      count++;
    } else if (opcode == NARSIL_FILTER_NOT) {
      uint32_t *bits = stack + ((count - 1) * words);
      for (size_t word = 0; word < words; word++) { bits[word] = program->live.words[word] & ~bits[word]; }
    } else if (opcode == NARSIL_FILTER_ANDNOT) {
      uint32_t *left = stack + ((count - 2) * words);
      const uint32_t *right = stack + ((count - 1) * words);
      for (size_t word = 0; word < words; word++) { left[word] &= ~right[word]; }
      count--;
    } else {
      size_t first = count - operand;
      uint32_t *left = stack + (first * words);
      for (size_t entry = first + 1; entry < count; entry++) {
        const uint32_t *right = stack + (entry * words);
        combine(opcode, left, right, words);
      }
      count = first + 1;
    }
  }
}

narsil_status narsil_evaluate_filter(narsil_workspace *workspace, const narsil_filter_program *program, uint32_t *into,
                                     size_t into_words) {
  memory_region output;
  size_t depth;
  if (workspace == NULL || (uintptr_t)into % _Alignof(uint32_t) != 0 ||
      !region_of(into, into_words, sizeof *into, &output) || !filter_regions_valid(program, output) ||
      !filter_plan_valid(program, &depth)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  size_t words = program->live.count;
  if (into_words < words) { return NARSIL_NEEDS_ROOM; }
  if (program->plan_words == 0) {
    memcpy(into, program->live.words, words * sizeof *into);
    return NARSIL_OK;
  }
  if (words > SIZE_MAX / (depth + 1)) { return NARSIL_OUT_OF_MEMORY; }
  filter_scratch *scratch = workspace_filter_scratch(workspace);
  narsil_status status = reserve_filter_scratch(scratch, words * (depth + 1));
  if (status != NARSIL_OK) { return status; }
  size_t edges = 0;
  for (size_t at = 0; at < program->plan_words; at += 4) {
    if (program->plan[at] == NARSIL_FILTER_TEST && program->plan[at + 2] == NARSIL_FILTER_POLYGON) {
      size_t count = (size_t)program->numbers[program->plan[at + 3]];
      if (count > edges) { edges = count; }
    }
  }
  if (edges > scratch->geo.capacity) {
    if (edges > SIZE_MAX / sizeof *scratch->geo.edges) { return NARSIL_OUT_OF_MEMORY; }
    filter_geo_edge *held = core_reallocate(scratch->geo.edges, edges * sizeof *held);
    if (held == NULL) { return NARSIL_OUT_OF_MEMORY; }
    scratch->geo.edges = held;
    scratch->geo.capacity = edges;
  }
  evaluate(program, scratch, depth);
  for (size_t word = 0; word < words; word++) { into[word] = scratch->words[word] & program->live.words[word]; }
  return NARSIL_OK;
}
