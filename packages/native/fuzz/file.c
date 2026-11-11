#include "file.h"

#include "input.h"

#include "../src/paged/cache.h"

void fuzz_page_checksums(fuzz_page_source source, uint8_t *checksums, uint64_t pages) {
  for (uint64_t page = 0; page < pages; page++) {
    uint64_t begin = page * source.page_bytes;
    if (begin > source.available) { return; }
    uint64_t length = source.available - begin < source.page_bytes ? source.available - begin : source.page_bytes;
    uint64_t remaining = source.length - begin;
    if (remaining < length) { length = remaining; }
    fuzz_store_u32(checksums + (page * FUZZ_CHECKSUM_BYTES), paged_checksum(source.bytes + begin, (size_t)length));
  }
}

#ifndef _WIN32

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <unistd.h>

enum { PATH_BYTES = 64 };

static char file_path[PATH_BYTES] = "/tmp/narsil-fuzz-XXXXXX";
static int file_descriptor = -1;

static void remove_file(void) { (void)unlink(file_path); }

const char *fuzz_file_write(const uint8_t *bytes, size_t length) {
  if (file_descriptor < 0) {
    file_descriptor = mkstemp(file_path);
    if (file_descriptor < 0) { return NULL; }
    if (atexit(remove_file) != 0) { return NULL; }
  }
  if (ftruncate(file_descriptor, 0) != 0) { return NULL; }
  size_t written = 0;
  while (written < length) {
    ssize_t step = pwrite(file_descriptor, bytes + written, length - written, (off_t)written);
    if (step <= 0) { return NULL; }
    written += (size_t)step;
  }
  return file_path;
}

#else

const char *fuzz_file_write(const uint8_t *bytes, size_t length) {
  (void)bytes;
  (void)length;
  return NULL;
}

#endif
