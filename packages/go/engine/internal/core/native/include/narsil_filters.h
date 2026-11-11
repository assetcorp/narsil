#ifndef NARSIL_FILTERS_H
#define NARSIL_FILTERS_H

#include "narsil_core.h"

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
  NARSIL_FILTER_TEST = 0,
  NARSIL_FILTER_AND = 1,
  NARSIL_FILTER_OR = 2,
  NARSIL_FILTER_NOT = 3,
  NARSIL_FILTER_ANDNOT = 4,
  NARSIL_FILTER_PRESENT = 5,
  NARSIL_FILTER_BITSET = 6
} narsil_filter_opcode;

typedef enum {
  NARSIL_FILTER_ABSENT = 0,
  NARSIL_FILTER_NUMERIC = 1,
  NARSIL_FILTER_BOOLEAN = 2,
  NARSIL_FILTER_ENUM = 3,
  NARSIL_FILTER_GEO = 4
} narsil_filter_kind;

typedef enum {
  NARSIL_FILTER_EQ = 0,
  NARSIL_FILTER_GT = 1,
  NARSIL_FILTER_GTE = 2,
  NARSIL_FILTER_LT = 3,
  NARSIL_FILTER_LTE = 4,
  NARSIL_FILTER_BETWEEN = 5,
  NARSIL_FILTER_ANY = 6,
  NARSIL_FILTER_ALL = 7,
  NARSIL_FILTER_PREFIX = 8,
  NARSIL_FILTER_SUFFIX = 9,
  NARSIL_FILTER_RADIUS = 10,
  NARSIL_FILTER_POLYGON = 11
} narsil_filter_operator;

typedef struct {
  const void *data;
  size_t length;
} narsil_filter_region;

#define NARSIL_FILTER_FIELD_REGIONS 6

typedef struct {
  uint32_t kind;
  size_t region_count;
  narsil_filter_region regions[NARSIL_FILTER_FIELD_REGIONS];
} narsil_filter_field;

typedef struct {
  const uint32_t *words;
  size_t count;
} narsil_filter_bits;

typedef struct {
  const uint32_t *plan;
  size_t plan_words;
  const double *numbers;
  size_t number_count;
  const uint16_t *units;
  size_t unit_count;
  const uint32_t *offsets;
  size_t offset_count;
  const uint32_t *lists;
  size_t list_words;
  const narsil_filter_bits *bitsets;
  size_t bitset_count;
  const narsil_filter_field *fields;
  size_t field_count;
  narsil_filter_bits live;
} narsil_filter_program;

narsil_status narsil_evaluate_filter(narsil_workspace *workspace, const narsil_filter_program *program, uint32_t *into,
                                     size_t into_words);

#ifdef __cplusplus
}
#endif

#endif
