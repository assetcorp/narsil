#include "parse.h"

#include "../../include/narsil_core.h"
#include "ast.h"

#include <stdint.h>

uint32_t pattern_parse_fail(pattern_reader *reader) {
  if (reader->tree->status == NARSIL_OK) { reader->tree->status = NARSIL_INVALID_ARGUMENT; }
  return PATTERN_NO_NODE;
}

static int ascii_punctuation(uint32_t point) {
  return (point >= '!' && point <= '/') || (point >= ':' && point <= '@') || (point >= '[' && point <= '`') ||
         (point >= '{' && point <= '~');
}

uint32_t pattern_parse_escape(pattern_reader *reader, int in_set) {
  uint32_t point = pattern_peek(reader);
  if (point == UINT32_MAX) { return pattern_parse_fail(reader); }
  reader->position++;
  pattern_ast *tree = reader->tree;
  switch (point) {
    case 'd':
      return pattern_node_add(tree, PATTERN_CLASS, PATTERN_DIGIT_CLASS);
    case 'w':
      return pattern_node_add(tree, PATTERN_CLASS, PATTERN_WORD_CLASS);
    case 's':
      return pattern_node_add(tree, PATTERN_CLASS, PATTERN_SPACE_CLASS);
    case 'b':
      return in_set != 0 ? pattern_parse_fail(reader) : pattern_node_add(tree, PATTERN_ASSERT, PATTERN_WORD_MASK);
    default:
      return ascii_punctuation(point) != 0 ? pattern_node_add(tree, PATTERN_LITERAL, point)
                                           : pattern_parse_fail(reader);
  }
}

static uint32_t set_member(pattern_reader *reader) {
  uint32_t point = pattern_peek(reader);
  if (point == UINT32_MAX || point == '[' || point == ']' || point == '-') { return pattern_parse_fail(reader); }
  reader->position++;
  return point == '\\' ? pattern_parse_escape(reader, 1) : pattern_node_add(reader->tree, PATTERN_LITERAL, point);
}

static uint32_t set_item(pattern_reader *reader) {
  uint32_t member = set_member(reader);
  pattern_ast *tree = reader->tree;
  if (tree->status != NARSIL_OK || member >= tree->count) { return PATTERN_NO_NODE; }
  if (tree->nodes[member].kind != PATTERN_LITERAL || pattern_peek(reader) != '-' ||
      (reader->position + 1 < reader->count && reader->points[reader->position + 1] == ']')) {
    return member;
  }
  reader->position++;
  uint32_t upper = set_member(reader);
  if (tree->status != NARSIL_OK || upper >= tree->count) { return PATTERN_NO_NODE; }
  uint32_t lower_point = tree->nodes[member].value;
  uint32_t upper_point = tree->nodes[upper].value;
  if (tree->nodes[upper].kind != PATTERN_LITERAL || lower_point > upper_point) { return pattern_parse_fail(reader); }
  tree->nodes[member].kind = PATTERN_SET_RANGE;
  tree->nodes[member].value = 0;
  tree->nodes[member].minimum = lower_point;
  tree->nodes[member].maximum = upper_point;
  return member;
}

uint32_t pattern_parse_set(pattern_reader *reader) {
  uint32_t negated = (uint32_t)(pattern_peek(reader) == '^');
  reader->position += negated;
  pattern_ast *tree = reader->tree;
  uint32_t set = pattern_node_add(tree, PATTERN_SET, negated);
  while (tree->status == NARSIL_OK && pattern_peek(reader) != ']') {
    uint32_t member = set_item(reader);
    pattern_node_append(tree, set, member);
  }
  if (tree->status != NARSIL_OK) { return PATTERN_NO_NODE; }
  reader->position++;
  if (tree->nodes[set].first == PATTERN_NO_NODE) { return pattern_parse_fail(reader); }
  return set;
}
