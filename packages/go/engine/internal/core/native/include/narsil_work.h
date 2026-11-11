#ifndef NARSIL_WORK_H
#define NARSIL_WORK_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  int64_t *spent;
  int64_t cap;
  const uint32_t *stop;
  uint64_t deadline;
} narsil_work_meter;

uint64_t narsil_clock_now(void);

#ifdef __cplusplus
}
#endif

#endif
