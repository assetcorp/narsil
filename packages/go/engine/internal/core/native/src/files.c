#include "../include/narsil_core.h"

#include <stddef.h>
#include <stdint.h>

static void forget_mapping(narsil_vector_file *file) {
  file->bytes = NULL;
  file->length = 0;
  file->mapping = NULL;
}

#ifdef _WIN32

#include <stdlib.h>
#include <windows.h>

static WCHAR *wide_path_of(const char *path) {
  int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, NULL, 0);
  if (length <= 0) { return NULL; }
  WCHAR *wide = calloc((size_t)length, sizeof *wide);
  if (wide == NULL) { return NULL; }
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, wide, length) != length) {
    free(wide);
    return NULL;
  }
  return wide;
}

static narsil_status map_open_file(HANDLE opened, narsil_vector_file *file) {
  LARGE_INTEGER size;
  if (!GetFileSizeEx(opened, &size) || size.QuadPart <= 0) { return NARSIL_FILE_UNREADABLE; }
  HANDLE mapping = CreateFileMappingW(opened, NULL, PAGE_READONLY, 0, 0, NULL);
  if (mapping == NULL) { return NARSIL_FILE_UNREADABLE; }
  void *view = MapViewOfFile(mapping, FILE_MAP_READ, 0, 0, 0);
  CloseHandle(mapping);
  if (view == NULL) { return NARSIL_FILE_UNREADABLE; }
  file->mapping = view;
  file->bytes = view;
  file->length = (uint64_t)size.QuadPart;
  return NARSIL_OK;
}

narsil_status narsil_vector_file_map(const char *path, narsil_vector_file *file) {
  if (path == NULL || file == NULL) { return NARSIL_INVALID_ARGUMENT; }
  forget_mapping(file);
  WCHAR *wide = wide_path_of(path);
  if (wide == NULL) { return NARSIL_FILE_UNREADABLE; }
  HANDLE opened = CreateFileW(wide, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL,
                              OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  free(wide);
  if (opened == INVALID_HANDLE_VALUE) { return NARSIL_FILE_UNREADABLE; }
  narsil_status status = map_open_file(opened, file);
  CloseHandle(opened);
  return status;
}

void narsil_vector_file_unmap(narsil_vector_file *file) {
  if (file == NULL || file->mapping == NULL) { return; }
  UnmapViewOfFile(file->mapping);
  forget_mapping(file);
}

#else

#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

static narsil_status map_open_file(int descriptor, narsil_vector_file *file) {
  struct stat status;
  if (fstat(descriptor, &status) != 0 || status.st_size <= 0) { return NARSIL_FILE_UNREADABLE; }
  size_t length = (size_t)status.st_size;
  void *view = mmap(NULL, length, PROT_READ, MAP_SHARED, descriptor, 0);
  if (view == MAP_FAILED) { return NARSIL_FILE_UNREADABLE; }
  (void)posix_madvise(view, length, POSIX_MADV_RANDOM);
  file->mapping = view;
  file->bytes = view;
  file->length = (uint64_t)length;
  return NARSIL_OK;
}

narsil_status narsil_vector_file_map(const char *path, narsil_vector_file *file) {
  if (path == NULL || file == NULL) { return NARSIL_INVALID_ARGUMENT; }
  forget_mapping(file);
  int descriptor = open(path, O_RDONLY | O_CLOEXEC);
  if (descriptor < 0) { return NARSIL_FILE_UNREADABLE; }
  narsil_status status = map_open_file(descriptor, file);
  (void)close(descriptor);
  return status;
}

void narsil_vector_file_unmap(narsil_vector_file *file) {
  if (file == NULL || file->mapping == NULL) { return; }
  (void)munmap(file->mapping, (size_t)file->length);
  forget_mapping(file);
}

#endif
