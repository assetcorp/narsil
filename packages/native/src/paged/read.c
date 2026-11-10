#include "cache.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_paged.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

narsil_status paged_read_section(narsil_workspace *workspace, narsil_page_cache *cache,
                                 const narsil_page_section *section, uint64_t offset, uint8_t *output, size_t length,
                                 narsil_page_fault *fault) {
  if (offset > section->length || length > section->length - offset) {
    *fault =
        (narsil_page_fault){narsil_paged_file_identity(section->file), section->offset, offset / section->page_bytes};
    return NARSIL_PAGE_INVALID;
  }
  size_t copied = 0;
  while (copied < length) {
    uint64_t position = offset + copied;
    const uint8_t *bytes = NULL;
    size_t available = 0;
    narsil_status status =
        paged_page(workspace, cache, section, position / section->page_bytes, &bytes, &available, fault);
    if (status != NARSIL_OK) { return status; }
    size_t start = (size_t)(position % section->page_bytes);
    size_t take = available - start;
    if (take > length - copied) { take = length - copied; }
    memcpy(output + copied, bytes + start, take);
    copied += take;
  }
  return NARSIL_OK;
}
