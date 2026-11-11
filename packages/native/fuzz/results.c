#include "input.h"

#include "../include/narsil_core.h"
#include "../include/narsil_facet_merge.h"
#include "../include/narsil_fusion.h"
#include "../include/narsil_group_merge.h"
#include "../include/narsil_merges.h"
#include "../include/narsil_pages.h"
#include "../include/narsil_pinned.h"

#include <stddef.h>
#include <stdint.h>

enum {
  MAX_OPERATIONS = 4,
  MAX_LISTS = 6,
  MAX_ENTRIES = 64,
  MAX_KEYS = 48,
  MAX_RANK = 40,
  MAX_OUTPUT = 96,
  FLAG_CHOICES = 2
};

enum { FACETS, FUSE, GROUPS, RANKINGS, SORTED, PINNED, PAGE, KINDS };

static uint32_t fuzz_flag(fuzz_input *input) {
  return fuzz_raw(input) ? fuzz_below(input, FLAG_CHOICES + 1) : fuzz_below(input, FLAG_CHOICES);
}

static void merge_facets(narsil_workspace *workspace, fuzz_input *input) {
  size_t lists = fuzz_count(input, MAX_LISTS);
  size_t values = fuzz_count(input, MAX_ENTRIES);
  size_t ranks = fuzz_count(input, MAX_RANK);
  size_t counts = fuzz_raw(input) ? fuzz_count(input, MAX_ENTRIES) : values;
  narsil_facet_merge_request request = {fuzz_offsets(input, lists, (uint32_t)values),
                                        lists + 1,
                                        fuzz_below_each(input, (fuzz_span){values, (uint32_t)ranks}),
                                        values,
                                        FUZZ_ARRAY(input, uint32_t, counts),
                                        counts,
                                        FUZZ_ARRAY(input, uint32_t, lists),
                                        lists,
                                        FUZZ_ARRAY(input, uint32_t, ranks),
                                        ranks,
                                        fuzz_flag(input),
                                        fuzz_flag(input),
                                        fuzz_below(input, MAX_ENTRIES)};
  size_t value_capacity = fuzz_count(input, MAX_OUTPUT);
  size_t count_capacity = fuzz_count(input, MAX_OUTPUT);
  size_t bound_capacity = fuzz_count(input, 2);
  narsil_facet_merge_output output = {FUZZ_ROOM(input, uint32_t, value_capacity),
                                      value_capacity,
                                      FUZZ_ROOM(input, uint32_t, count_capacity),
                                      count_capacity,
                                      FUZZ_ROOM(input, uint32_t, bound_capacity),
                                      bound_capacity,
                                      0};
  if (input->exhausted_memory) { return; }
  (void)narsil_merge_facets(workspace, &request, &output);
}

static narsil_fusion_leg fuzz_leg(fuzz_input *input, uint32_t key_count) {
  uint32_t count = (uint32_t)fuzz_count(input, MAX_KEYS);
  return (narsil_fusion_leg){fuzz_below_each(input, (fuzz_span){count, key_count + 1}), fuzz_numbers(input, count),
                             count};
}

static void fuse(narsil_workspace *workspace, fuzz_input *input) {
  uint32_t key_count = (uint32_t)fuzz_count(input, MAX_KEYS);
  narsil_fusion_request request = {fuzz_below(input, 3),
                                   fuzz_number(input),
                                   fuzz_number(input),
                                   fuzz_leg(input, key_count),
                                   fuzz_leg(input, key_count),
                                   FUZZ_ARRAY(input, uint32_t, key_count),
                                   key_count};
  uint32_t capacity = (uint32_t)fuzz_count(input, MAX_OUTPUT);
  narsil_fusion_output output = {FUZZ_ROOM(input, uint32_t, capacity), FUZZ_ROOM(input, double, capacity), capacity, 0};
  if (input->exhausted_memory) { return; }
  (void)narsil_fuse(workspace, &request, &output);
}

static void merge_groups(narsil_workspace *workspace, fuzz_input *input) {
  size_t keys = fuzz_count(input, MAX_LISTS);
  size_t entries = fuzz_count(input, MAX_ENTRIES);
  int loose = fuzz_raw(input);
  uint32_t has_scores = fuzz_flag(input);
  uint32_t has_present = has_scores == 1 ? fuzz_flag(input) : 0;
  uint32_t sorted = fuzz_flag(input);
  size_t score_count = has_scores == 1 || loose ? entries : 0;
  size_t present_count = has_present == 1 || loose ? fuzz_nonempty_bit_words(entries) : 0;
  uint32_t *ranks = fuzz_below_each(input, (fuzz_span){entries, MAX_RANK});
  uint32_t *id_ranks = sorted == 0 && !loose ? ranks : fuzz_below_each(input, (fuzz_span){entries, MAX_RANK});
  narsil_group_merge_request request = {FUZZ_ARRAY(input, uint32_t, keys),
                                        keys,
                                        fuzz_offsets(input, keys, (uint32_t)entries),
                                        keys + 1,
                                        fuzz_numbers(input, score_count),
                                        score_count,
                                        FUZZ_ARRAY(input, uint32_t, present_count),
                                        present_count,
                                        ranks,
                                        entries,
                                        id_ranks,
                                        entries,
                                        has_scores,
                                        has_present,
                                        sorted,
                                        fuzz_below(input, 4),
                                        fuzz_flag(input),
                                        fuzz_below(input, MAX_LISTS)};
  size_t key_capacity = fuzz_count(input, MAX_LISTS + 1);
  size_t index_capacity = fuzz_count(input, MAX_OUTPUT);
  narsil_group_merge_output output = {FUZZ_ROOM(input, uint32_t, key_capacity),
                                      key_capacity,
                                      FUZZ_ROOM(input, uint32_t, key_capacity + 1),
                                      key_capacity + 1,
                                      FUZZ_ROOM(input, uint32_t, index_capacity),
                                      index_capacity,
                                      FUZZ_ROOM(input, uint32_t, index_capacity),
                                      index_capacity,
                                      0};
  if (input->exhausted_memory) { return; }
  (void)narsil_merge_groups(workspace, &request, &output);
}

static void merge_lists(narsil_workspace *workspace, fuzz_input *input, int scored) {
  size_t lists = fuzz_count(input, MAX_LISTS);
  size_t entries = fuzz_count(input, MAX_ENTRIES);
  size_t score_count = scored ? entries : fuzz_count(input, 1);
  narsil_merge_request request = {
      fuzz_offsets(input, lists, (uint32_t)entries),          lists + 1, fuzz_numbers(input, score_count), score_count,
      fuzz_below_each(input, (fuzz_span){entries, MAX_RANK}), entries,   fuzz_below(input, MAX_ENTRIES)};
  size_t list_capacity = fuzz_count(input, MAX_OUTPUT);
  size_t index_capacity = fuzz_count(input, MAX_OUTPUT);
  narsil_merge_output output = {FUZZ_ROOM(input, uint32_t, list_capacity), list_capacity,
                                FUZZ_ROOM(input, uint32_t, index_capacity), index_capacity, 0};
  if (input->exhausted_memory) { return; }
  if (scored) {
    (void)narsil_merge_rankings(workspace, &request, &output);
  } else {
    (void)narsil_merge_sorted(workspace, &request, &output);
  }
}

static void place_pinned(narsil_workspace *workspace, fuzz_input *input) {
  uint32_t count = (uint32_t)fuzz_count(input, MAX_ENTRIES);
  size_t pins = fuzz_count(input, MAX_LISTS);
  int32_t *ranked = FUZZ_ARRAY(input, int32_t, pins);
  if (ranked != NULL && !fuzz_raw(input)) {
    for (size_t at = 0; at < pins; at++) { ranked[at] = (int32_t)fuzz_below(input, count + 1) - 1; }
  }
  narsil_pinned_request request = {count,
                                   ranked,
                                   pins,
                                   fuzz_below_each(input, (fuzz_span){pins, MAX_ENTRIES + 1}),
                                   pins,
                                   fuzz_flag(input),
                                   fuzz_below(input, MAX_ENTRIES)};
  size_t capacity = fuzz_count(input, MAX_OUTPUT);
  narsil_pinned_output output = {FUZZ_ROOM(input, int32_t, capacity), capacity, 0};
  if (input->exhausted_memory) { return; }
  (void)narsil_place_pinned(workspace, &request, &output);
}

static void page_start(fuzz_input *input) {
  uint32_t count = (uint32_t)fuzz_count(input, MAX_ENTRIES);
  uint32_t has_scores = fuzz_flag(input);
  size_t words = fuzz_nonempty_bit_words(count);
  size_t scores = has_scores == 1 ? count : 0;
  int present = has_scores == 1 && (fuzz_byte(input) & 1U) == 1U;
  size_t present_words = present ? words : 0;
  narsil_page_request request = {count,
                                 fuzz_flag(input),
                                 has_scores,
                                 fuzz_flag(input),
                                 fuzz_numbers(input, scores),
                                 scores,
                                 present ? FUZZ_ARRAY(input, uint32_t, present_words) : NULL,
                                 present_words,
                                 FUZZ_ARRAY(input, uint32_t, words),
                                 words,
                                 fuzz_number(input)};
  uint32_t *start = FUZZ_ROOM(input, uint32_t, 1);
  if (input->exhausted_memory) { return; }
  (void)narsil_page_start(&request, start);
}

static void apply(narsil_workspace *workspace, fuzz_input *input, uint32_t operation) {
  switch (operation) {
    case FACETS:
      merge_facets(workspace, input);
      break;
    case FUSE:
      fuse(workspace, input);
      break;
    case GROUPS:
      merge_groups(workspace, input);
      break;
    case RANKINGS:
      merge_lists(workspace, input, 1);
      break;
    case SORTED:
      merge_lists(workspace, input, 0);
      break;
    case PINNED:
      place_pinned(workspace, input);
      break;
    default:
      page_start(input);
      break;
  }
}

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  narsil_workspace *workspace = NULL;
  if (narsil_workspace_create(&workspace) != NARSIL_OK) { return 0; }
  fuzz_input input = fuzz_begin(data, size);
  uint32_t operations = 1 + fuzz_below(&input, MAX_OPERATIONS);
  for (uint32_t at = 0; at < operations && !input.exhausted_memory; at++) {
    apply(workspace, &input, fuzz_below(&input, KINDS));
  }
  narsil_workspace_destroy(workspace);
  fuzz_release(&input);
  return 0;
}
