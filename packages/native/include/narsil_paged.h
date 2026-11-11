#ifndef NARSIL_PAGED_H
#define NARSIL_PAGED_H

#include "narsil_core.h"

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define NARSIL_PAGE_SLOT_BYTES 65536U

typedef struct narsil_paged_file narsil_paged_file;

typedef struct {
  uint8_t *bytes;
  size_t byte_capacity;
  uint64_t *files;
  uint64_t *offsets;
  uint64_t *pages;
  uint32_t *lengths;
  uint32_t *checksums;
  size_t slots;
} narsil_page_cache;

typedef struct {
  const narsil_paged_file *file;
  uint64_t offset;
  uint64_t length;
  uint32_t page_bytes;
  const uint8_t *checksums;
  size_t checksum_bytes;
} narsil_page_section;

typedef struct {
  uint64_t file;
  uint64_t section;
  uint64_t page;
} narsil_page_fault;

typedef struct {
  uint32_t first;
  uint32_t count;
  uint32_t documents;
  uint32_t fields;
} narsil_paged_posting_list;

typedef struct {
  const narsil_page_section *offsets;
  const narsil_page_section *values;
  uint32_t first;
  uint32_t count;
} narsil_paged_position_list;

typedef struct {
  uint32_t *offsets;
  size_t offset_capacity;
  uint32_t *values;
  size_t value_capacity;
} narsil_paged_position_output;

typedef struct {
  const narsil_page_section *offsets;
  const narsil_page_section *values;
  uint32_t ordinal;
  uint32_t token_count;
} narsil_paged_removal_list;

typedef struct {
  uint32_t *values;
  size_t capacity;
  uint32_t *count;
} narsil_paged_removal_output;

typedef struct {
  const narsil_page_section *offsets;
  const narsil_page_section *values;
  uint32_t ordinal;
} narsil_paged_id_request;

typedef struct {
  uint8_t *bytes;
  size_t capacity;
  uint32_t *length;
} narsil_paged_id_output;

typedef struct {
  uint32_t position;
  uint32_t documents;
} narsil_paged_ordinal_request;

typedef struct {
  uint32_t first;
  uint32_t count;
} narsil_paged_totals_request;

typedef struct {
  const narsil_page_section *sequences;
  const narsil_page_section *terms;
  uint32_t ordinal;
} narsil_paged_write_request;

typedef struct {
  uint64_t *values;
  size_t capacity;
} narsil_paged_write_output;

narsil_status narsil_paged_file_open(const char *path, narsil_paged_file **file);
void narsil_paged_file_close(narsil_paged_file *file);
uint64_t narsil_paged_file_length(const narsil_paged_file *file);
uint64_t narsil_paged_file_identity(const narsil_paged_file *file);
narsil_status narsil_read_page(narsil_workspace *workspace, narsil_page_cache *cache,
                               const narsil_page_section *section, uint64_t page, uint8_t *output,
                               size_t output_capacity, narsil_page_fault *fault);
narsil_status narsil_read_paged_postings(narsil_workspace *workspace, narsil_page_cache *cache,
                                         const narsil_page_section *section, narsil_paged_posting_list list,
                                         uint8_t *output, size_t output_capacity, narsil_page_fault *fault);
narsil_status narsil_read_paged_positions(narsil_workspace *workspace, narsil_page_cache *cache,
                                          narsil_paged_position_list list, narsil_paged_position_output output,
                                          narsil_page_fault *fault);
narsil_status narsil_read_paged_ordinal(narsil_workspace *workspace, narsil_page_cache *cache,
                                        const narsil_page_section *section, narsil_paged_ordinal_request request,
                                        uint32_t *output, size_t capacity, narsil_page_fault *fault);
narsil_status narsil_read_paged_totals(narsil_workspace *workspace, narsil_page_cache *cache,
                                       const narsil_page_section *section, narsil_paged_totals_request request,
                                       double *output, size_t capacity, narsil_page_fault *fault);
narsil_status narsil_read_paged_write_record(narsil_workspace *workspace, narsil_page_cache *cache,
                                             narsil_paged_write_request request, narsil_paged_write_output output,
                                             narsil_page_fault *fault);
narsil_status narsil_read_paged_removals(narsil_workspace *workspace, narsil_page_cache *cache,
                                         narsil_paged_removal_list list, narsil_paged_removal_output output,
                                         narsil_page_fault *fault);
narsil_status narsil_read_paged_id(narsil_workspace *workspace, narsil_page_cache *cache,
                                   narsil_paged_id_request request, narsil_paged_id_output output,
                                   narsil_page_fault *fault);

#ifdef __cplusplus
}
#endif

#endif
