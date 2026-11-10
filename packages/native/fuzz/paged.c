#include "file.h"
#include "input.h"

#include "../include/narsil_core.h"

#ifndef _WIN32

#include "../include/narsil_paged.h"
#include "../include/narsil_paged_vectors.h"

#include <stddef.h>
#include <stdint.h>

enum {
  MAX_FILE_BYTES = 40000,
  RECORD_PAGE_BYTES = 16384,
  CACHE_SLOTS = 2,
  MAX_OUTPUT_WORDS = 2048,
  MAX_LIST_ROWS = 96,
  MAX_SMALL_VALUE = 128,
  MAX_DIMENSION = 4,
  MAX_VECTORS = 24,
  MAX_LEVELS = 3,
  MAX_EF = 32,
  CODE_WIDTHS = 5,
  METRIC_CHOICES = 4
};

static const uint32_t CODE_WIDTH_CHOICES[CODE_WIDTHS] = {0, 1, 2, 4, 8};

typedef struct {
  narsil_paged_file *file;
  const uint8_t *bytes;
  size_t length;
} paged_source;

static uint8_t cache_bytes[CACHE_SLOTS * NARSIL_PAGE_SLOT_BYTES];
static uint64_t cache_files[CACHE_SLOTS];
static uint64_t cache_offsets[CACHE_SLOTS];
static uint64_t cache_pages[CACHE_SLOTS];
static uint32_t cache_lengths[CACHE_SLOTS];
static uint32_t cache_checksums[CACHE_SLOTS];

static narsil_page_section fuzz_section(fuzz_input *input, const paged_source *source, uint64_t wanted) {
  narsil_page_section section = {source->file, 0, 0, RECORD_PAGE_BYTES, NULL, 0};
  if (fuzz_raw(input)) {
    section.page_bytes = fuzz_u32(input);
  } else {
    section.page_bytes = (fuzz_byte(input) & 1U) == 0 ? RECORD_PAGE_BYTES : NARSIL_PAGE_SLOT_BYTES;
  }
  section.offset = fuzz_raw(input) ? fuzz_u64(input) : fuzz_below(input, (uint32_t)source->length + 1);
  uint64_t room = section.offset <= source->length ? source->length - section.offset : 0;
  section.length = wanted != 0 && wanted <= room ? wanted : fuzz_below(input, (uint32_t)room + 1);
  if (fuzz_raw(input)) { section.length = fuzz_u64(input); }
  uint64_t page_bytes = section.page_bytes == 0 ? 1 : section.page_bytes;
  uint64_t pages = (section.length / page_bytes) + (section.length % page_bytes != 0);
  section.checksum_bytes = pages > MAX_OUTPUT_WORDS ? 0 : (size_t)pages * FUZZ_CHECKSUM_BYTES;
  if (fuzz_raw(input)) { section.checksum_bytes = fuzz_below(input, MAX_OUTPUT_WORDS); }
  uint8_t *checksums = FUZZ_ARRAY(input, uint8_t, section.checksum_bytes);
  section.checksums = checksums;
  if (checksums == NULL || fuzz_raw(input) || section.offset > source->length) { return section; }
  fuzz_page_source paged = {source->bytes + section.offset, source->length - section.offset, section.length,
                            page_bytes};
  fuzz_page_checksums(paged, checksums, section.checksum_bytes / FUZZ_CHECKSUM_BYTES);
  return section;
}

static narsil_page_cache *fuzz_cache(fuzz_input *input) {
  static narsil_page_cache cache = {cache_bytes, sizeof cache_bytes, cache_files,     cache_offsets,
                                    cache_pages, cache_lengths,      cache_checksums, CACHE_SLOTS};
  return (fuzz_byte(input) & 1U) == 0 ? &cache : NULL;
}

static size_t output_count(fuzz_input *input) { return fuzz_below(input, MAX_OUTPUT_WORDS + 1); }

static void read_columns(narsil_workspace *workspace, fuzz_input *input, const paged_source *source) {
  narsil_page_section first = fuzz_section(input, source, 0);
  narsil_page_section second = fuzz_section(input, source, 0);
  narsil_page_cache *cache = fuzz_cache(input);
  narsil_page_fault fault = {0, 0, 0};
  size_t page_capacity = (fuzz_byte(input) & 1U) == 0 ? NARSIL_PAGE_SLOT_BYTES : output_count(input);
  uint8_t *page = FUZZ_ROOM(input, uint8_t, page_capacity);
  size_t words = output_count(input);
  uint32_t *values = FUZZ_ROOM(input, uint32_t, words);
  size_t extra_words = output_count(input);
  uint32_t *extra = FUZZ_ROOM(input, uint32_t, extra_words);
  double *totals = FUZZ_ROOM(input, double, words);
  uint64_t *records = FUZZ_ROOM(input, uint64_t, extra_words);
  uint32_t count = 0;
  if (input->exhausted_memory) { return; }
  (void)narsil_read_page(workspace, cache, &first, fuzz_below(input, 4), page, page_capacity, &fault);
  narsil_paged_posting_list postings = {fuzz_below(input, MAX_LIST_ROWS), fuzz_below(input, MAX_LIST_ROWS),
                                        fuzz_u32(input) % MAX_SMALL_VALUE, fuzz_u32(input) % MAX_SMALL_VALUE};
  (void)narsil_read_paged_postings(workspace, cache, &first, postings, page, page_capacity, &fault);
  narsil_paged_position_list positions = {&first, &second, fuzz_below(input, MAX_LIST_ROWS),
                                          fuzz_below(input, MAX_LIST_ROWS)};
  (void)narsil_read_paged_positions(workspace, cache, positions,
                                    (narsil_paged_position_output){values, words, extra, extra_words}, &fault);
  narsil_paged_ordinal_request ordinal = {fuzz_below(input, MAX_LIST_ROWS), fuzz_u32(input) % MAX_SMALL_VALUE};
  (void)narsil_read_paged_ordinal(workspace, cache, &first, ordinal, values, words, &fault);
  narsil_paged_totals_request total = {fuzz_below(input, MAX_LIST_ROWS), fuzz_below(input, MAX_LIST_ROWS)};
  (void)narsil_read_paged_totals(workspace, cache, &second, total, totals, words, &fault);
  narsil_paged_write_request record = {&first, &second, fuzz_below(input, MAX_LIST_ROWS)};
  (void)narsil_read_paged_write_record(workspace, cache, record, (narsil_paged_write_output){records, extra_words},
                                       &fault);
  narsil_paged_removal_list removal = {&first, &second, fuzz_below(input, MAX_LIST_ROWS),
                                       fuzz_below(input, MAX_LIST_ROWS)};
  (void)narsil_read_paged_removals(workspace, cache, removal, (narsil_paged_removal_output){extra, extra_words, &count},
                                   &fault);
  narsil_paged_id_request id_request = {&first, &second, fuzz_below(input, MAX_LIST_ROWS)};
  (void)narsil_read_paged_id(workspace, cache, id_request, (narsil_paged_id_output){page, page_capacity, &count},
                             &fault);
}

static narsil_paged_graph_part fuzz_part(fuzz_input *input, const paged_source *source, uint32_t total) {
  uint8_t *levels = FUZZ_ARRAY(input, uint8_t, total);
  uint32_t *offsets = FUZZ_ARRAY(input, uint32_t, (size_t)total + 1);
  narsil_page_section neighbours = fuzz_section(input, source, 0);
  if (levels != NULL && offsets != NULL && !fuzz_raw(input)) {
    uint32_t used = 0;
    for (uint32_t at = 0; at < total; at++) {
      levels[at] = (uint8_t)(1 + (levels[at] % MAX_LEVELS));
      uint64_t room = neighbours.length > used ? neighbours.length - used : 0;
      uint32_t step = (uint32_t)(offsets[at] % ((room / 2) + 1));
      offsets[at] = used;
      used += step - (step % sizeof(uint32_t));
    }
    offsets[total] = used;
  }
  return (narsil_paged_graph_part){0, total, levels, total, offsets, (size_t)total + 1, neighbours};
}

static void search_vectors(narsil_workspace *workspace, fuzz_input *input, const paged_source *source) {
  uint32_t dimension = 1 + fuzz_below(input, MAX_DIMENSION);
  uint32_t total = 1 + fuzz_below(input, MAX_VECTORS);
  uint32_t bits = CODE_WIDTH_CHOICES[fuzz_below(input, CODE_WIDTHS)];
  uint64_t record_bytes = narsil_record_bytes(dimension, bits);
  narsil_page_section records = fuzz_section(input, source, record_bytes * total);
  int with_dead = (fuzz_byte(input) & 1U) != 0;
  size_t dead_bytes = with_dead ? fuzz_bit_bytes(total) : 0;
  narsil_paged_vector_file file = {0,
                                   total,
                                   with_dead ? FUZZ_ARRAY(input, uint8_t, dead_bytes) : NULL,
                                   dead_bytes,
                                   fuzz_section(input, source, (uint64_t)dimension * sizeof(float) * total),
                                   bits == 0 ? NULL : &records};
  narsil_paged_graph_part part = fuzz_part(input, source, total);
  size_t centroid_count = bits == 0 ? 0 : dimension;
  narsil_paged_vector_field field = {dimension,
                                     fuzz_below(input, METRIC_CHOICES),
                                     total,
                                     fuzz_below(input, total + 1),
                                     (int)fuzz_below(input, 2),
                                     fuzz_below(input, MAX_LEVELS),
                                     bits,
                                     FUZZ_ARRAY(input, float, centroid_count),
                                     centroid_count,
                                     &file,
                                     1,
                                     &part,
                                     1};
  size_t words = fuzz_bit_words(total);
  uint32_t search_breadth = 1 + fuzz_below(input, MAX_EF);
  fuzz_meter_state state;
  narsil_paged_vector_request request = {FUZZ_ARRAY(input, float, dimension),
                                         dimension,
                                         1 + fuzz_below(input, total),
                                         search_breadth,
                                         fuzz_below(input, search_breadth + 1),
                                         (int)fuzz_below(input, 2),
                                         fuzz_number(input),
                                         (fuzz_byte(input) & 1U) == 0 ? NULL : FUZZ_ARRAY(input, uint32_t, words),
                                         0,
                                         NULL,
                                         0,
                                         fuzz_meter(input, &state)};
  request.accepted_words = request.accepted == NULL ? 0 : words;
  size_t capacity = fuzz_below(input, MAX_VECTORS + 1);
  narsil_paged_vector_output output = {FUZZ_ROOM(input, uint32_t, capacity), capacity,
                                       FUZZ_ROOM(input, double, capacity), capacity};
  uint32_t count = 0;
  narsil_page_fault fault = {0, 0, 0};
  if (!input->exhausted_memory) {
    (void)narsil_search_paged_vectors(workspace, fuzz_cache(input), &field, &request, &output, &count, &fault);
  }
}

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  fuzz_input input = fuzz_begin(data, size);
  size_t length = fuzz_below(&input, MAX_FILE_BYTES + 1);
  const uint8_t *bytes = FUZZ_ARRAY(&input, uint8_t, length);
  narsil_workspace *workspace = NULL;
  paged_source source = {NULL, bytes, length};
  const char *path = input.exhausted_memory ? NULL : fuzz_file_write(bytes, length);
  if (path != NULL && narsil_paged_file_open(path, &source.file) == NARSIL_OK &&
      narsil_workspace_create(&workspace) == NARSIL_OK) {
    read_columns(workspace, &input, &source);
    search_vectors(workspace, &input, &source);
  }
  narsil_workspace_destroy(workspace);
  narsil_paged_file_close(source.file);
  fuzz_release(&input);
  return 0;
}

#else

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  (void)data;
  (void)size;
  return 0;
}

#endif
