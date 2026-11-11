#include "../../include/narsil_work.h"
#include "constants.h"

#include <stdint.h>

#ifdef _WIN32

#include <windows.h>

uint64_t narsil_clock_now(void) {
  LARGE_INTEGER counter;
  LARGE_INTEGER frequency;
  if (!QueryPerformanceCounter(&counter) || !QueryPerformanceFrequency(&frequency) || counter.QuadPart < 0 ||
      frequency.QuadPart <= 0) {
    return UINT64_MAX;
  }
  uint64_t ticks = (uint64_t)counter.QuadPart;
  uint64_t rate = (uint64_t)frequency.QuadPart;
  uint64_t seconds = ticks / rate;
  if (seconds > UINT64_MAX / NARSIL_NANOSECONDS_PER_SECOND) { return UINT64_MAX; }
  uint64_t fraction =
      (uint64_t)(((long double)(ticks % rate) * (long double)NARSIL_NANOSECONDS_PER_SECOND) / (long double)rate);
  uint64_t base = seconds * NARSIL_NANOSECONDS_PER_SECOND;
  return fraction > UINT64_MAX - base ? UINT64_MAX : base + fraction;
}

#else

#include <time.h>

uint64_t narsil_clock_now(void) {
  struct timespec stamp;
  if (clock_gettime(CLOCK_MONOTONIC, &stamp) != 0 || stamp.tv_sec < 0) { return UINT64_MAX; }
  uint64_t seconds = (uint64_t)stamp.tv_sec;
  if (seconds > UINT64_MAX / NARSIL_NANOSECONDS_PER_SECOND) { return UINT64_MAX; }
  uint64_t base = seconds * NARSIL_NANOSECONDS_PER_SECOND;
  uint64_t fraction = (uint64_t)stamp.tv_nsec;
  return fraction > UINT64_MAX - base ? UINT64_MAX : base + fraction;
}

#endif
