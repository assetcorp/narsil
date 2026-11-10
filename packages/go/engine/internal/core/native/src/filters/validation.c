#include "../../include/narsil_filters.h"
#include "constants.h"
#include "geo_constants.h"
#include "internal.h"

#include <math.h>
#include <stddef.h>
#include <stdint.h>

static int valid_text(const narsil_filter_program *program, size_t index) {
  if (index >= program->offset_count - 1) { return 0; }
  size_t start = program->offsets[index];
  size_t end = program->offsets[index + 1];
  return start <= end && end <= program->unit_count && end - start <= FILTER_MAX_TEXT;
}

static int valid_numbers(int boolean, const narsil_filter_program *program, size_t start, size_t count) {
  if (start > program->number_count || count > program->number_count - start) { return 0; }
  for (size_t at = start; at < start + count; at++) {
    double value = program->numbers[at];
    if (!isfinite(value) || (boolean && value != 0 && value != 1)) { return 0; }
  }
  return 1;
}

static int list_count(double value) { return value >= 0 && value <= FILTER_MAX_ITEMS && trunc(value) == value; }

static int valid_location(double lat, double lon) {
  return isfinite(lat) && fabs(lat) <= FILTER_LATITUDE_LIMIT && isfinite(lon) && fabs(lon) <= FILTER_LONGITUDE_LIMIT;
}

static int valid_geo(uint32_t operator, const narsil_filter_program *program, size_t operand) {
  if (operand >= program->number_count) { return 0; }
  const double *numbers = program->numbers + operand;
  size_t length = program->number_count - operand;
  if (operator == NARSIL_FILTER_RADIUS) {
    return length >= 4 && valid_location(numbers[0], numbers[1]) && numbers[2] >= 0 &&
           (numbers[3] == 0 || numbers[3] == 1);
  }
  if (operator != NARSIL_FILTER_POLYGON || !list_count(numbers[0]) || numbers[0] < 3) { return 0; }
  size_t count = (size_t)numbers[0];
  if (count > (length - 1) / 2) { return 0; }
  for (size_t at = 1; at < 1 + (count * 2); at += 2) {
    if (!valid_location(numbers[at], numbers[at + 1])) { return 0; }
  }
  return 1;
}

static int valid_enum(uint32_t operator, const narsil_filter_program *program, size_t operand) {
  if (operator == NARSIL_FILTER_ANY || operator == NARSIL_FILTER_ALL) {
    if (operand >= program->list_words / 2) { return 0; }
    size_t start = program->lists[operand * 2];
    size_t count = program->lists[(operand * 2) + 1];
    if (count > FILTER_MAX_ITEMS || start >= program->offset_count || count >= program->offset_count - start) {
      return 0;
    }
    for (size_t at = start; at < start + count; at++) {
      if (!valid_text(program, at)) { return 0; }
    }
    return 1;
  }
  return (operator == NARSIL_FILTER_EQ || operator == NARSIL_FILTER_PREFIX || operator == NARSIL_FILTER_SUFFIX) &&
         valid_text(program, operand);
}

static int valid_test(const narsil_filter_program *program, const narsil_filter_field *field, uint32_t operator,
                      size_t operand) {
  if (operator > NARSIL_FILTER_POLYGON || field->kind == NARSIL_FILTER_ABSENT) { return 0; }
  if (field->kind == NARSIL_FILTER_ENUM) { return valid_enum(operator, program, operand); }
  if (field->kind == NARSIL_FILTER_GEO) { return valid_geo(operator, program, operand); }
  int boolean = field->kind == NARSIL_FILTER_BOOLEAN;
  if (operator == NARSIL_FILTER_ANY || operator == NARSIL_FILTER_ALL) {
    return operand < program->number_count && list_count(program->numbers[operand]) &&
           valid_numbers(boolean, program, operand + 1, (size_t)program->numbers[operand]);
  }
  return operator <= (boolean ? NARSIL_FILTER_EQ : NARSIL_FILTER_BETWEEN) &&
         valid_numbers(boolean, program, operand, operator == NARSIL_FILTER_BETWEEN ? 2 : 1);
}

static int instruction_valid(const narsil_filter_program *program, const uint32_t *instruction, size_t *depth) {
  uint32_t opcode = instruction[0];
  size_t field = instruction[1];
  uint32_t operator = instruction[2];
  size_t operand = instruction[3];
  if (opcode == NARSIL_FILTER_TEST) {
    if (field >= program->field_count || !valid_test(program, &program->fields[field], operator, operand)) { return 0; }
    (*depth)++;
  } else if (opcode == NARSIL_FILTER_PRESENT) {
    if (field >= program->field_count) { return 0; }
    (*depth)++;
  } else if (opcode == NARSIL_FILTER_BITSET) {
    if (operand >= program->bitset_count) { return 0; }
    (*depth)++;
  } else if (opcode == NARSIL_FILTER_NOT) {
    if (*depth < 1) { return 0; }
  } else if (opcode == NARSIL_FILTER_ANDNOT) {
    if (*depth < 2) { return 0; }
    (*depth)--;
  } else if (opcode == NARSIL_FILTER_AND || opcode == NARSIL_FILTER_OR) {
    if (operand < 1 || operand > *depth) { return 0; }
    *depth -= operand - 1;
  } else {
    return 0;
  }
  return 1;
}

int filter_plan_valid(const narsil_filter_program *program, size_t *maximum_depth) {
  size_t depth = 0;
  size_t tests = 0;
  *maximum_depth = 1;
  for (size_t at = 0; at < program->plan_words; at += 4) {
    if (program->plan[at] == NARSIL_FILTER_TEST && ++tests > FILTER_MAX_TESTS) { return 0; }
    if (!instruction_valid(program, program->plan + at, &depth)) { return 0; }
    if (depth > *maximum_depth) { *maximum_depth = depth; }
  }
  return program->plan_words == 0 || depth == 1;
}
