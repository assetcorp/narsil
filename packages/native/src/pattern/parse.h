#ifndef NARSIL_PATTERN_PARSE_H
#define NARSIL_PATTERN_PARSE_H

#include "ast.h"

#include <stddef.h>
#include <stdint.h>

typedef struct {
  pattern_ast *tree;
  const uint32_t *points;
  size_t count;
  size_t position;
} pattern_reader;

static inline uint32_t pattern_peek(const pattern_reader *reader) {
  return reader->position < reader->count ? reader->points[reader->position] : UINT32_MAX;
}

uint32_t pattern_parse_fail(pattern_reader *reader);
uint32_t pattern_parse_escape(pattern_reader *reader, int in_set);
uint32_t pattern_parse_set(pattern_reader *reader);
uint32_t pattern_parse_repeat(pattern_reader *reader, uint32_t body);
uint32_t pattern_parse_number_range(pattern_reader *reader);
uint32_t pattern_parse_regex(pattern_reader *reader);
uint32_t pattern_parse_wildcard(pattern_reader *reader);

#endif
