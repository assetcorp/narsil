#include "internal.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_field_merge.h"
#include "../segment_merge/internal.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static int text_compare(const field_merge_key *left, const field_merge_key *right, int reversed) {
  const uint16_t *left_text = left->text;
  const uint16_t *right_text = right->text;
  size_t length = left->length < right->length ? left->length : right->length;
  for (size_t at = 0; at < length; at++) {
    uint16_t first = left_text[reversed ? left->length - at - 1 : at];
    uint16_t second = right_text[reversed ? right->length - at - 1 : at];
    if (first != second) { return first < second ? -1 : 1; }
  }
  return left->length < right->length ? -1 : left->length > right->length;
}

static int text_order(const void *left, const void *right) { return text_compare(left, right, 0); }
static int suffix_order(const void *left, const void *right) { return text_compare(left, right, 1); }

static int compare_runs(const field_merge_key *left, const field_merge_key *right) {
  const uint32_t *left_run = left->text;
  const uint32_t *right_run = right->text;
  for (size_t at = 0; at < 3; at++) {
    if (left_run[at] != right_run[at]) { return left_run[at] < right_run[at] ? -1 : 1; }
  }
  return 0;
}

static int run_order(const void *left, const void *right) { return compare_runs(left, right); }

static int row_order(const void *first, const void *second) {
  const field_merge_row *left = first;
  const field_merge_row *right = second;
  if (left->key != right->key) { return left->key < right->key ? -1 : 1; }
  if (left->ordinal != right->ordinal) { return left->ordinal < right->ordinal ? -1 : 1; }
  return 0;
}

typedef struct {
  size_t keys;
  size_t rows;
} dictionary_counts;

static narsil_status validate_postings(const narsil_field_merge_source *source, size_t count,
                                       dictionary_counts *counts) {
  const uint32_t *offsets = source->regions[2].data;
  const uint32_t *postings = source->regions[3].data;
  if (offsets[0] != 0 || offsets[count] != source->regions[3].length || count > UINT32_MAX - counts->keys) {
    return NARSIL_FILE_UNREADABLE;
  }
  counts->keys += count;
  for (size_t at = 0; at < count; at++) {
    if (offsets[at] > offsets[at + 1] || offsets[at + 1] > source->regions[3].length) { return NARSIL_FILE_UNREADABLE; }
  }
  for (size_t at = 0; at < source->regions[3].length; at++) {
    if (postings[at] >= source->document_count) { return NARSIL_FILE_UNREADABLE; }
    if (source->mapping[postings[at]] == UINT32_MAX) { continue; }
    if (counts->rows == UINT32_MAX) { return NARSIL_INVALID_ARGUMENT; }
    counts->rows++;
  }
  return NARSIL_OK;
}

static narsil_status validate_pattern(field_merge_scratch *scratch, const narsil_field_merge_source *source) {
  const uint32_t *ordinals = source->regions[0].data;
  const uint32_t *runs = source->regions[1].data;
  for (size_t at = 0; at < source->regions[1].length; at++) {
    if (runs[at] > UINT32_C(0x10ffff)) { return NARSIL_FILE_UNREADABLE; }
  }
  for (size_t at = 0; at < source->regions[0].length; at++) {
    if (ordinals[at] >= source->document_count) { return NARSIL_FILE_UNREADABLE; }
    uint32_t target = source->mapping[ordinals[at]];
    if (target != UINT32_MAX) { scratch->documents[target].present = 1; }
  }
  return NARSIL_OK;
}

static narsil_status validate_text(const narsil_field_merge_source *source, size_t count) {
  const uint32_t *text = source->regions[1].data;
  const uint32_t *suffixes = source->regions[4].data;
  if (text[0] != 0 || text[count] != source->regions[0].length) { return NARSIL_FILE_UNREADABLE; }
  for (size_t at = 0; at < count; at++) {
    if (text[at] > text[at + 1] || text[at + 1] > source->regions[0].length || suffixes[at] >= count) {
      return NARSIL_FILE_UNREADABLE;
    }
  }
  return NARSIL_OK;
}

static narsil_status validate(field_merge_scratch *scratch, const narsil_field_merge_request *request,
                              dictionary_counts *counts) {
  int pattern = request->kind == NARSIL_MERGE_PATTERN;
  for (size_t source_index = 0; source_index < request->source_count; source_index++) {
    const narsil_field_merge_source *source = request->sources + source_index;
    size_t count = pattern ? source->regions[1].length / 3 : source->regions[1].length - 1;
    narsil_status status = validate_postings(source, count, counts);
    if (status != NARSIL_OK) { return status; }
    status = pattern ? validate_pattern(scratch, source) : validate_text(source, count);
    if (status != NARSIL_OK) { return status; }
  }
  return NARSIL_OK;
}

static narsil_status reserve(field_merge_scratch *scratch, size_t keys, size_t rows) {
  narsil_status status =
      segment_merge_reserve((void **)&scratch->keys, keys, &scratch->key_capacity, sizeof *scratch->keys);
  if (status != NARSIL_OK) { return status; }
  status =
      segment_merge_reserve((void **)&scratch->suffixes, keys, &scratch->suffix_capacity, sizeof *scratch->suffixes);
  if (status != NARSIL_OK) { return status; }
  status = segment_merge_reserve((void **)&scratch->key_targets, keys, &scratch->key_target_capacity,
                                 sizeof *scratch->key_targets);
  if (status != NARSIL_OK) { return status; }
  return segment_merge_reserve((void **)&scratch->rows, rows, &scratch->row_capacity, sizeof *scratch->rows);
}

static int kept_key(const narsil_field_merge_source *source, size_t index) {
  const uint32_t *offsets = source->regions[2].data;
  const uint32_t *postings = source->regions[3].data;
  for (size_t row = offsets[index]; row < offsets[index + 1]; row++) {
    if (source->mapping[postings[row]] != UINT32_MAX) { return 1; }
  }
  return 0;
}

static void collect_keys(field_merge_scratch *scratch, const narsil_field_merge_request *request) {
  int pattern = request->kind == NARSIL_MERGE_PATTERN;
  size_t flat = 0;
  for (size_t source_index = 0; source_index < request->source_count; source_index++) {
    const narsil_field_merge_source *source = request->sources + source_index;
    size_t count = pattern ? source->regions[1].length / 3 : source->regions[1].length - 1;
    for (size_t at = 0; at < count; at++, flat++) {
      scratch->key_targets[flat] = UINT32_MAX;
      if (pattern && !kept_key(source, at)) { continue; }
      field_merge_key key = {.source = source_index, .index = (uint32_t)flat};
      if (pattern) {
        const uint32_t *runs = source->regions[1].data;
        key.text = runs + (at * 3);
        key.length = 3;
      } else {
        const uint32_t *text = source->regions[1].data;
        const uint16_t *units = source->regions[0].data;
        key.text = units == NULL ? NULL : units + text[at];
        key.length = text[at + 1] - text[at];
      }
      scratch->keys[scratch->key_count++] = key;
    }
  }
}

static narsil_status unite_keys(field_merge_scratch *scratch, int pattern) {
  int (*compare)(const void *, const void *) = pattern ? run_order : text_order;
  if (scratch->key_count > 1) { qsort(scratch->keys, scratch->key_count, sizeof *scratch->keys, compare); }
  size_t distinct = 0;
  uint64_t units = 0;
  for (size_t at = 0; at < scratch->key_count; at++) {
    field_merge_key key = scratch->keys[at];
    if (distinct == 0 || compare(&key, scratch->keys + distinct - 1) != 0) {
      units += key.length;
      if (units > UINT32_MAX || distinct == UINT32_MAX - 1) { return NARSIL_INVALID_ARGUMENT; }
      key.target = (uint32_t)distinct;
      scratch->keys[distinct++] = key;
    }
    scratch->key_targets[key.index] = (uint32_t)distinct - 1;
  }
  scratch->key_count = distinct;
  if (pattern) {
    scratch->sizes.lengths[1] = (uint32_t)units;
  } else {
    scratch->sizes.lengths[0] = (uint32_t)units;
    scratch->sizes.lengths[1] = (uint32_t)distinct + 1;
    scratch->sizes.lengths[4] = (uint32_t)distinct;
    if (distinct > 0) { memcpy(scratch->suffixes, scratch->keys, distinct * sizeof *scratch->keys); }
    if (distinct > 1) { qsort(scratch->suffixes, distinct, sizeof *scratch->suffixes, suffix_order); }
  }
  scratch->sizes.lengths[2] = (uint32_t)distinct + 1;
  return NARSIL_OK;
}

static void collect_rows(field_merge_scratch *scratch, const narsil_field_merge_request *request) {
  int pattern = request->kind == NARSIL_MERGE_PATTERN;
  size_t flat = 0;
  for (size_t source_index = 0; source_index < request->source_count; source_index++) {
    const narsil_field_merge_source *source = request->sources + source_index;
    size_t count = pattern ? source->regions[1].length / 3 : source->regions[1].length - 1;
    const uint32_t *offsets = source->regions[2].data;
    const uint32_t *postings = source->regions[3].data;
    for (size_t at = 0; at < count; at++, flat++) {
      uint32_t key = scratch->key_targets[flat];
      if (key == UINT32_MAX) { continue; }
      for (size_t row = offsets[at]; row < offsets[at + 1]; row++) {
        uint32_t ordinal = source->mapping[postings[row]];
        if (ordinal == UINT32_MAX) { continue; }
        scratch->rows[scratch->row_count++] = (field_merge_row){.ordinal = ordinal, .key = key};
      }
    }
  }
  if (scratch->row_count > 1) { qsort(scratch->rows, scratch->row_count, sizeof *scratch->rows, row_order); }
  size_t kept = 0;
  for (size_t at = 0; at < scratch->row_count; at++) {
    if (kept > 0 && row_order(scratch->rows + kept - 1, scratch->rows + at) == 0) { continue; }
    scratch->rows[kept++] = scratch->rows[at];
  }
  scratch->row_count = kept;
  scratch->sizes.lengths[3] = (uint32_t)kept;
}

narsil_status field_merge_dictionary(field_merge_scratch *scratch, const narsil_field_merge_request *request) {
  dictionary_counts counts = {0};
  narsil_status status = validate(scratch, request, &counts);
  if (status != NARSIL_OK) { return status; }
  status = reserve(scratch, counts.keys, counts.rows);
  if (status != NARSIL_OK) { return status; }
  collect_keys(scratch, request);
  status = unite_keys(scratch, request->kind == NARSIL_MERGE_PATTERN);
  if (status != NARSIL_OK) { return status; }
  collect_rows(scratch, request);
  if (request->kind == NARSIL_MERGE_PATTERN) {
    for (size_t at = 0; at < request->document_count; at++) {
      if (scratch->documents[at].present) { scratch->sizes.lengths[0]++; }
    }
  }
  return NARSIL_OK;
}

void field_merge_publish_dictionary(const field_merge_scratch *scratch, const narsil_field_merge_request *request,
                                    const narsil_field_merge_output *output) {
  int pattern = request->kind == NARSIL_MERGE_PATTERN;
  uint32_t *offsets = output->regions[2].data;
  uint32_t *postings = output->regions[3].data;
  uint32_t text_at = 0;
  size_t row = 0;
  offsets[0] = 0;
  if (!pattern) { ((uint32_t *)output->regions[1].data)[0] = 0; }
  for (size_t at = 0; at < scratch->key_count; at++) {
    field_merge_key key = scratch->keys[at];
    if (pattern) {
      memcpy((uint32_t *)output->regions[1].data + (at * 3), key.text, 3 * sizeof(uint32_t));
    } else {
      if (key.length > 0) {
        memcpy((uint16_t *)output->regions[0].data + text_at, key.text, key.length * sizeof(uint16_t));
      }
      text_at += (uint32_t)key.length;
      ((uint32_t *)output->regions[1].data)[at + 1] = text_at;
      ((uint32_t *)output->regions[4].data)[at] = scratch->suffixes[at].target;
    }
    while (row < scratch->row_count && scratch->rows[row].key == at) {
      postings[row] = scratch->rows[row].ordinal;
      row++;
    }
    offsets[at + 1] = (uint32_t)row;
  }
  if (pattern) {
    uint32_t *ordinals = output->regions[0].data;
    size_t count = 0;
    for (uint32_t ordinal = 0; ordinal < request->document_count; ordinal++) {
      if (scratch->documents[ordinal].present) { ordinals[count++] = ordinal; }
    }
  }
}
