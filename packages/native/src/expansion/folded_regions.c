#include "folded.h"
#include "internal.h"

#include "../../include/narsil_analysis.h"
#include "../../include/narsil_expansion.h"
#include "../../include/narsil_folding.h"
#include "../folding/table.h"
#include "../regions.h"
#include "../segments/regions.h"

#include <stddef.h>
#include <stdint.h>

static int writes_apart(const segment_regions *regions) {
  for (size_t at = 0; at < regions->write_count; at++) {
    for (size_t before = 0; before < at; before++) {
      if (overlaps(regions->writes[at], regions->writes[before])) { return 0; }
    }
  }
  return 1;
}

static int table_memory(const segment_regions *regions, const narsil_fold_table *table) {
  return segment_region_input(regions, table, 1, sizeof *table) &&
         segment_region_input(regions, table->entries, table->count, sizeof *table->entries) &&
         segment_region_input(regions, table->by_key, table->count, sizeof *table->by_key) &&
         segment_region_input(regions, table->by_fold, table->count, sizeof *table->by_fold) &&
         segment_region_input(regions, table->units.units, table->units.length, sizeof *table->units.units) &&
         segment_region_input(regions, table->token_surfaces, table->token_surface_count,
                              sizeof *table->token_surfaces);
}

int folded_tables_valid(const segment_regions *regions, const narsil_expansion_segment *segments,
                        const narsil_fold_table *const *tables, size_t count) {
  if ((uintptr_t)tables % _Alignof(const narsil_fold_table *) != 0 ||
      !segment_region_input(regions, (const void *)tables, count, sizeof *tables)) {
    return 0;
  }
  for (size_t at = 0; at < count; at++) {
    const narsil_fold_table *table = tables[at];
    if (table == NULL || (uintptr_t)table % _Alignof(narsil_fold_table) != 0 || !table_memory(regions, table) ||
        !fold_table_matches(table, segments + at)) {
      return 0;
    }
  }
  return 1;
}

static int word_regions(const segment_regions *regions, const narsil_folded_word *word) {
  if (!expansion_text_region(regions, word->key, word->key_length) ||
      !expansion_text_region(regions, word->own, word->own_length) || word->excluded_count > UINT32_MAX ||
      (uintptr_t)word->excluded % _Alignof(narsil_term) != 0 ||
      !segment_region_input(regions, word->excluded, word->excluded_count, sizeof *word->excluded)) {
    return 0;
  }
  for (size_t at = 0; at < word->excluded_count; at++) {
    if (!expansion_text_region(regions, word->excluded[at].units, word->excluded[at].length)) { return 0; }
  }
  return 1;
}

int folded_regions(const narsil_folded_request *request, const narsil_folded_output *output, uint32_t *count) {
  if (request == NULL || (uintptr_t)request % _Alignof(narsil_folded_request) != 0 || output == NULL ||
      (uintptr_t)output % _Alignof(narsil_folded_output) != 0 || request->segment_count > UINT32_MAX ||
      request->word_count > (UINT32_MAX - 1) / 2 ||
      (uintptr_t)request->segments % _Alignof(narsil_expansion_segment) != 0 ||
      (uintptr_t)request->words % _Alignof(narsil_folded_word) != 0) {
    return 0;
  }
  segment_regions regions = {0};
  if (!segment_region_write(&regions, output->segments, output->segment_capacity, sizeof *output->segments) ||
      !segment_region_write(&regions, output->tokens, output->token_capacity, sizeof *output->tokens) ||
      !segment_region_write(&regions, output->starts, output->start_capacity, sizeof *output->starts) ||
      !segment_region_write(&regions, count, 1, sizeof *count) || !writes_apart(&regions) ||
      !segment_region_input(&regions, request, 1, sizeof *request) ||
      !segment_region_input(&regions, output, 1, sizeof *output) ||
      !segment_region_input(&regions, request->segments, request->segment_count, sizeof *request->segments) ||
      !segment_region_input(&regions, request->words, request->word_count, sizeof *request->words)) {
    return 0;
  }
  for (size_t at = 0; at < request->segment_count; at++) {
    if (!expansion_source_regions(request->segments + at, &regions)) { return 0; }
  }
  if (!folded_tables_valid(&regions, request->segments, request->tables, request->segment_count)) { return 0; }
  for (size_t at = 0; at < request->word_count; at++) {
    if (!word_regions(&regions, request->words + at)) { return 0; }
  }
  return 1;
}

int folded_prefix_regions(const narsil_folded_prefix_request *request, const narsil_expansion_output *output,
                          uint32_t *count) {
  if (request == NULL || (uintptr_t)request % _Alignof(narsil_folded_prefix_request) != 0 ||
      !expansion_regions(&request->prefix, output, count)) {
    return 0;
  }
  segment_regions regions = {0};
  return segment_region_write(&regions, output->segments, output->segment_capacity, sizeof *output->segments) &&
         segment_region_write(&regions, output->tokens, output->token_capacity, sizeof *output->tokens) &&
         segment_region_write(&regions, output->factors, output->factor_capacity, sizeof *output->factors) &&
         segment_region_write(&regions, count, 1, sizeof *count) &&
         segment_region_input(&regions, request, 1, sizeof *request) &&
         expansion_text_region(&regions, request->folded, request->folded_length) &&
         folded_tables_valid(&regions, request->prefix.segments, request->tables, request->prefix.segment_count);
}

int folded_partial_regions(const narsil_folded_partial_request *request, const narsil_partial_output *output,
                           uint32_t *count) {
  if (request == NULL || (uintptr_t)request % _Alignof(narsil_folded_partial_request) != 0 ||
      !partial_regions(&request->partial, output, count) || (uintptr_t)request->folded % _Alignof(narsil_term) != 0) {
    return 0;
  }
  const narsil_expansion_output *added = &output->additions;
  segment_regions regions = {0};
  if (!segment_region_write(&regions, added->segments, added->segment_capacity, sizeof *added->segments) ||
      !segment_region_write(&regions, added->tokens, added->token_capacity, sizeof *added->tokens) ||
      !segment_region_write(&regions, added->factors, added->factor_capacity, sizeof *added->factors) ||
      !segment_region_write(&regions, output->starts, output->start_capacity, sizeof *output->starts) ||
      !segment_region_write(&regions, count, 1, sizeof *count) ||
      !segment_region_input(&regions, request, 1, sizeof *request) ||
      !segment_region_input(&regions, request->folded, request->partial.word_count, sizeof *request->folded) ||
      !folded_tables_valid(&regions, request->partial.segments, request->tables, request->partial.segment_count)) {
    return 0;
  }
  for (size_t at = 0; at < request->partial.word_count; at++) {
    if (!expansion_text_region(&regions, request->folded[at].units, request->folded[at].length)) { return 0; }
  }
  return 1;
}
