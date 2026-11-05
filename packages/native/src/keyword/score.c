#include "score.h"

#include "pass.h"
#include "rows.h"
#include "scratch.h"
#include "select.h"

#include "../math/fdlibm.h"

#include "../../include/narsil_keyword.h"

#include <stddef.h>
#include <stdint.h>

#define IDF_HALF_DOCUMENT 0.5

typedef struct {
  int member_mode;
  double idf;
  int has_term;
  uint32_t term;
  double factor;
  double partial_factor;
} keyword_run;

typedef struct {
  const keyword_pass *pass;
  keyword_run *run;
  const keyword_row_keys *keys;
  const keyword_rows *rows;
} list_scan;

typedef struct {
  const uint32_t *order;
  uint32_t begin;
  uint32_t end;
  uint32_t ordinal;
} row_run;

double keyword_idf(double document_frequency, double total_documents) {
  if (total_documents == 0) { return 0; }
  double rest = (total_documents - document_frequency) + IDF_HALF_DOCUMENT;
  return fdlibm_log((rest / (document_frequency + IDF_HALF_DOCUMENT)) + 1);
}

void keyword_list_rows(const keyword_pass *pass, uint32_t list, keyword_rows *rows) {
  const narsil_keyword_request *request = pass->request;
  if ((keyword_list_flags(request, list) & NARSIL_KEYWORD_LIST_FROM_ROWS) != 0) {
    rows->doc_ids = request->row_doc_ids;
    rows->fields = request->row_fields;
    rows->narrow_frequencies = NULL;
    rows->wide_frequencies = request->row_frequencies;
  } else {
    rows->doc_ids = request->pool_doc_ids;
    rows->fields = request->pool_fields;
    rows->narrow_frequencies = request->pool_frequencies;
    rows->wide_frequencies = NULL;
  }
}

void keyword_list_keys(const keyword_pass *pass, uint32_t list, keyword_row_keys *keys) {
  keyword_rows rows;
  keyword_list_rows(pass, list, &rows);
  keys->doc_ids = rows.doc_ids;
  keys->fields = rows.fields;
  keys->name_ranks = pass->request->name_ranks;
  keys->field_count = pass->field_count;
}

static void touch(const keyword_pass *pass, uint32_t ordinal) {
  keyword_scratch *scratch = pass->scratch;
  if (scratch->stamps[ordinal] == scratch->generation) { return; }
  scratch->stamps[ordinal] = scratch->generation;
  scratch->scores[ordinal] = 0;
  if (pass->tracks_coverage) {
    scratch->covered[ordinal] = 0;
    scratch->last_term[ordinal] = 0;
  }
  scratch->touched[scratch->touched_count++] = ordinal;
}

static void cover(const keyword_pass *pass, uint32_t ordinal, uint32_t term) {
  if (!pass->tracks_coverage) { return; }
  keyword_scratch *scratch = pass->scratch;
  if (scratch->last_term[ordinal] == term + 1) { return; }
  scratch->last_term[ordinal] = term + 1;
  scratch->covered[ordinal]++;
}

static void score_row(const list_scan *scan, uint32_t row, uint32_t ordinal) {
  const keyword_pass *pass = scan->pass;
  uint32_t field = scan->rows->fields[row];
  if (!keyword_searchable(pass, field)) { return; }
  touch(pass, ordinal);
  pass->scratch->scores[ordinal] +=
      keyword_row_score(pass, scan->run->idf, keyword_frequency(scan->rows, row), field, ordinal);
  if (scan->run->has_term) { cover(pass, ordinal, scan->run->term); }
}

static void score_members(const list_scan *scan, const row_run *rows) {
  const keyword_pass *pass = scan->pass;
  const keyword_run *run = scan->run;
  const uint8_t *partial_marks = pass->request->partial_marks;
  uint32_t ordinal = rows->ordinal;
  double sum = 0;
  int any = 0;
  for (uint32_t place = rows->begin; place < rows->end; place++) {
    uint32_t row = rows->order[place];
    uint32_t field = scan->rows->fields[row];
    if (!keyword_searchable(pass, field)) { continue; }
    double factor = partial_marks[field] == 1 ? run->partial_factor : run->factor;
    if (!(factor > 0)) { continue; }
    sum += keyword_row_score(pass, run->idf, keyword_frequency(scan->rows, row), field, ordinal) * factor;
    any = 1;
  }
  if (!any) { return; }
  keyword_scratch *scratch = pass->scratch;
  if (scratch->group_stamps[ordinal] != scratch->group_generation) {
    scratch->group_stamps[ordinal] = scratch->group_generation;
    scratch->group_best[ordinal] = sum;
    scratch->group_touched[scratch->group_touched_count++] = ordinal;
  } else if (sum > scratch->group_best[ordinal]) {
    scratch->group_best[ordinal] = sum;
  }
}

static void score_run(const list_scan *scan, const row_run *rows) {
  if (scan->run->member_mode) {
    score_members(scan, rows);
    return;
  }
  for (uint32_t place = rows->begin; place < rows->end; place++) { score_row(scan, rows->order[place], rows->ordinal); }
}

static void score_unordered_list(const list_scan *scan, uint32_t begin, uint32_t length) {
  keyword_scratch *scratch = scan->pass->scratch;
  const uint32_t *doc_ids = scan->keys->doc_ids;
  for (uint32_t place = 0; place < length; place++) { scratch->order[place] = begin + place; }
  const uint32_t *sorted = keyword_sort_rows(scan->keys, scratch, length);
  uint32_t place = 0;
  while (place < length) {
    uint32_t ordinal = doc_ids[sorted[place]];
    uint32_t end = place + 1;
    while (end < length && doc_ids[sorted[end]] == ordinal) { end++; }
    if (keyword_scorable(scan->pass, ordinal)) {
      row_run rows = {sorted, place, end, ordinal};
      score_run(scan, &rows);
    }
    place = end;
  }
}

const uint32_t *keyword_rank_ordered_run(const keyword_pass *pass, const keyword_row_keys *keys, uint32_t begin,
                                         uint32_t count) {
  keyword_scratch *scratch = pass->scratch;
  uint32_t *rows = scratch->order;
  for (uint32_t row = 0; row < count; row++) { rows[row] = begin + row; }
  if (count > 1 && !keyword_ranks_ascend(keys, begin, count)) { return keyword_sort_rows(keys, scratch, count); }
  return rows;
}

static void score_ordered_list(const list_scan *scan, uint32_t begin, uint32_t length) {
  const uint32_t *doc_ids = scan->keys->doc_ids;
  uint32_t end = begin + length;
  uint32_t place = begin;
  while (place < end) {
    uint32_t ordinal = doc_ids[place];
    uint32_t run_end = place + 1;
    while (run_end < end && doc_ids[run_end] == ordinal) { run_end++; }
    if (keyword_scorable(scan->pass, ordinal)) {
      uint32_t count = run_end - place;
      if (count == 1 && !scan->run->member_mode) {
        score_row(scan, place, ordinal);
      } else {
        row_run rows = {keyword_rank_ordered_run(scan->pass, scan->keys, place, count), 0, count, ordinal};
        score_run(scan, &rows);
      }
    }
    place = run_end;
  }
}

static void score_list(const keyword_pass *pass, keyword_run *run, uint32_t list) {
  const narsil_keyword_request *request = pass->request;
  keyword_rows rows;
  keyword_row_keys keys;
  keyword_list_rows(pass, list, &rows);
  keyword_list_keys(pass, list, &keys);
  run->factor = keyword_list_value(request, list, NARSIL_KEYWORD_LIST_FACTOR);
  run->partial_factor = keyword_list_value(request, list, NARSIL_KEYWORD_LIST_PARTIAL_FACTOR);
  list_scan scan = {pass, run, &keys, &rows};
  uint32_t begin = keyword_list_start(request, list);
  uint32_t length = keyword_list_length(request, list);
  if ((keyword_list_flags(request, list) & NARSIL_KEYWORD_LIST_ORDERED) == 0) {
    score_unordered_list(&scan, begin, length);
  } else {
    score_ordered_list(&scan, begin, length);
  }
}

static void finish_group(const keyword_pass *pass, uint32_t term) {
  keyword_scratch *scratch = pass->scratch;
  for (uint32_t index = 0; index < scratch->group_touched_count; index++) {
    uint32_t ordinal = scratch->group_touched[index];
    touch(pass, ordinal);
    scratch->scores[ordinal] += scratch->group_best[ordinal];
    cover(pass, ordinal, term);
  }
}

static uint32_t slot_word(const narsil_keyword_request *request, uint32_t slot, uint32_t word) {
  return request->slots[((size_t)slot * NARSIL_KEYWORD_SLOT_STRIDE) + word];
}

static double list_idf(const narsil_keyword_request *request, uint32_t list) {
  return keyword_idf(keyword_list_value(request, list, NARSIL_KEYWORD_LIST_DOCUMENT_FREQUENCY),
                     request->total_documents);
}

uint32_t keyword_score_every_slot(const keyword_pass *pass) {
  const narsil_keyword_request *request = pass->request;
  double total_documents = request->total_documents;
  keyword_begin(pass->scratch);
  uint32_t list_from = 0;
  uint32_t value_from = 0;
  for (uint32_t slot = 0; slot < request->slot_count; slot++) {
    uint32_t kind = slot_word(request, slot, NARSIL_KEYWORD_SLOT_KIND);
    uint32_t term = slot_word(request, slot, NARSIL_KEYWORD_SLOT_TERM);
    uint32_t list_end = slot_word(request, slot, NARSIL_KEYWORD_SLOT_LIST_END);
    uint32_t value_end = slot_word(request, slot, NARSIL_KEYWORD_SLOT_VALUE_END);
    keyword_run run = {0, 0, 0, term, 0, 0};
    if (kind == NARSIL_KEYWORD_TERM_SLOT) {
      run.has_term = 1;
      for (uint32_t list = list_from; list < list_end; list++) {
        run.idf = list_idf(request, list);
        score_list(pass, &run, list);
      }
    } else if (kind == NARSIL_KEYWORD_GROUP_SLOT) {
      run.member_mode = 1;
      run.has_term = 1;
      run.idf = keyword_idf(request->slot_values[value_from], total_documents);
      keyword_begin_group(pass->scratch);
      for (uint32_t list = list_from; list < list_end; list++) { score_list(pass, &run, list); }
      finish_group(pass, term);
    } else {
      double idf = 0;
      for (uint32_t value = value_from; value < value_end; value++) {
        idf += keyword_idf(request->slot_values[value], total_documents);
      }
      run.idf = idf;
      for (uint32_t list = list_from; list < list_end; list++) { score_list(pass, &run, list); }
    }
    list_from = list_end;
    value_from = value_end;
  }
  return keyword_select_kept(pass);
}
