#ifndef _WIN32

#include "file.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_paged.h"

#include <errno.h>
#include <fcntl.h>
#include <stddef.h>
#include <stdint.h>
#include <sys/stat.h>
#include <unistd.h>

narsil_status paged_open(narsil_paged_file *file, const char *path) {
  int descriptor = open(path, O_RDONLY | O_CLOEXEC | O_NONBLOCK);
  if (descriptor < 0) { return NARSIL_PAGE_UNREADABLE; }
  struct stat information;
  if (fstat(descriptor, &information) != 0 || information.st_size < 0 || !S_ISREG(information.st_mode)) {
    (void)close(descriptor);
    return NARSIL_PAGE_UNREADABLE;
  }
  file->descriptor = descriptor;
  file->length = (uint64_t)information.st_size;
  return NARSIL_OK;
}

void paged_close(narsil_paged_file *file) { (void)close(file->descriptor); }

narsil_status paged_read(const narsil_paged_file *file, uint64_t offset, uint8_t *into, size_t length) {
  if (offset > INT64_MAX || length > (uint64_t)INT64_MAX - offset) { return NARSIL_PAGE_UNREADABLE; }
  size_t copied = 0;
  while (copied < length) {
    ssize_t received = pread(file->descriptor, into + copied, length - copied, (off_t)(offset + copied));
    if (received < 0 && errno == EINTR) { continue; }
    if (received <= 0) { return NARSIL_PAGE_UNREADABLE; }
    copied += (size_t)received;
  }
  return NARSIL_OK;
}

#else

typedef int narsil_paged_posix_unused;

#endif
