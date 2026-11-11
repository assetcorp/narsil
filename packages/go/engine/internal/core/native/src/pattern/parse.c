#include "parse.h"

#include "../../include/narsil_core.h"
#include "ast.h"
#include "constants.h"

#include <stdint.h>

typedef struct {
  uint32_t sequence;
  uint32_t choice;
} group_frame;

static group_frame group_start(pattern_ast *tree) {
  group_frame group = {pattern_node_add(tree, PATTERN_SEQUENCE, 0), pattern_node_add(tree, PATTERN_CHOICE, 0)};
  return group;
}

static void branch_finish(pattern_ast *tree, group_frame *group) {
  pattern_node_append(tree, group->choice, pattern_node_finish(tree, group->sequence));
}

static uint32_t group_finish(pattern_ast *tree, group_frame *group) {
  branch_finish(tree, group);
  return pattern_node_finish(tree, group->choice);
}

static uint32_t parse_atom(pattern_reader *reader, uint32_t point) {
  pattern_ast *tree = reader->tree;
  switch (point) {
    case '\\':
      return pattern_parse_escape(reader, 0);
    case '.':
      return pattern_node_add(tree, PATTERN_ANY, 0);
    case '^':
      return pattern_node_add(tree, PATTERN_ASSERT, PATTERN_START_MASK);
    case '$':
      return pattern_node_add(tree, PATTERN_ASSERT, PATTERN_END_MASK);
    case '[':
      return pattern_parse_set(reader);
    case '<':
      return pattern_parse_number_range(reader);
    case '*':
    case '+':
    case '?':
    case '{':
    case '}':
    case ']':
    case '>':
      return pattern_parse_fail(reader);
    default:
      return pattern_node_add(tree, PATTERN_LITERAL, point);
  }
}

uint32_t pattern_parse_regex(pattern_reader *reader) {
  pattern_ast *tree = reader->tree;
  group_frame groups[PATTERN_MAX_GROUP_DEPTH + 1];
  uint32_t depth = 0;
  groups[0] = group_start(tree);
  while (reader->position < reader->count && tree->status == NARSIL_OK) {
    uint32_t point = reader->points[reader->position++];
    if (point == '(') {
      if (depth == PATTERN_MAX_GROUP_DEPTH || pattern_peek(reader) == '?') { return pattern_parse_fail(reader); }
      groups[++depth] = group_start(tree);
    } else if (point == '|') {
      branch_finish(tree, groups + depth);
      groups[depth].sequence = pattern_node_add(tree, PATTERN_SEQUENCE, 0);
    } else {
      uint32_t atom = PATTERN_NO_NODE;
      if (point == ')') {
        if (depth == 0) { return pattern_parse_fail(reader); }
        atom = group_finish(tree, groups + depth);
        depth--;
      } else {
        atom = parse_atom(reader, point);
      }
      pattern_node_append(tree, groups[depth].sequence, pattern_parse_repeat(reader, atom));
    }
  }
  if (depth != 0) { return pattern_parse_fail(reader); }
  return group_finish(tree, groups);
}

uint32_t pattern_parse_wildcard(pattern_reader *reader) {
  pattern_ast *tree = reader->tree;
  uint32_t sequence = pattern_node_add(tree, PATTERN_SEQUENCE, 0);
  pattern_node_append(tree, sequence, pattern_node_add(tree, PATTERN_ASSERT, PATTERN_START_MASK));
  while (reader->position < reader->count && tree->status == NARSIL_OK) {
    uint32_t point = reader->points[reader->position++];
    uint32_t node = PATTERN_NO_NODE;
    if (point == '*' || point == '?') {
      node = pattern_node_add(tree, PATTERN_ANY, 0);
      if (point == '*') {
        pattern_bounds bounds = {0, PATTERN_UNBOUNDED};
        node = pattern_node_repeat(tree, node, bounds);
      }
    } else {
      if (point == '\\') {
        if (reader->position == reader->count) { return pattern_parse_fail(reader); }
        point = reader->points[reader->position++];
      }
      node = pattern_node_add(tree, PATTERN_LITERAL, point);
    }
    pattern_node_append(tree, sequence, node);
  }
  pattern_node_append(tree, sequence, pattern_node_add(tree, PATTERN_ASSERT, PATTERN_END_MASK));
  return sequence;
}
