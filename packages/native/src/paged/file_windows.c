#ifdef _WIN32

#include "file.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_paged.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <windows.h>

enum { OFFSET_HIGH_SHIFT = 32 };

narsil_status paged_open(narsil_paged_file *file, const char *path) {
  int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, NULL, 0);
  if (length <= 0 || (size_t)length > SIZE_MAX / sizeof(WCHAR)) { return NARSIL_PAGE_UNREADABLE; }
  WCHAR *wide = calloc((size_t)length, sizeof *wide);
  if (wide == NULL) { return NARSIL_OUT_OF_MEMORY; }
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, wide, length) != length) {
    free(wide);
    return NARSIL_PAGE_UNREADABLE;
  }
  HANDLE descriptor = CreateFileW(wide, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL,
                                  OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OVERLAPPED, NULL);
  free(wide);
  if (descriptor == INVALID_HANDLE_VALUE) { return NARSIL_PAGE_UNREADABLE; }
  LARGE_INTEGER size;
  if (GetFileType(descriptor) != FILE_TYPE_DISK || !GetFileSizeEx(descriptor, &size) || size.QuadPart < 0) {
    CloseHandle(descriptor);
    return NARSIL_PAGE_UNREADABLE;
  }
  file->descriptor = descriptor;
  file->length = (uint64_t)size.QuadPart;
  return NARSIL_OK;
}

void paged_close(narsil_paged_file *file) { CloseHandle(file->descriptor); }

narsil_status paged_read(const narsil_paged_file *file, uint64_t offset, uint8_t *into, size_t length) {
  if (offset > INT64_MAX || length > (uint64_t)INT64_MAX - offset || length > MAXDWORD) {
    return NARSIL_PAGE_UNREADABLE;
  }
  OVERLAPPED operation = {0};
  operation.Offset = (DWORD)offset;
  operation.OffsetHigh = (DWORD)(offset >> OFFSET_HIGH_SHIFT);
  operation.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (operation.hEvent == NULL) { return NARSIL_PAGE_UNREADABLE; }
  DWORD received = 0;
  HANDLE descriptor = file->descriptor;
  BOOL read = ReadFile(descriptor, into, (DWORD)length, &received, &operation);
  if (!read && GetLastError() == ERROR_IO_PENDING) {
    read = GetOverlappedResult(descriptor, &operation, &received, TRUE);
  }
  CloseHandle(operation.hEvent);
  return read && received == length ? NARSIL_OK : NARSIL_PAGE_UNREADABLE;
}

#else

typedef int narsil_paged_windows_unused;

#endif
