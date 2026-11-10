#ifndef NARSIL_THREAD_YIELD_H
#define NARSIL_THREAD_YIELD_H

#ifdef _WIN32
#include <windows.h>
#else
#include <sched.h>
#endif

static inline void narsil_yield_thread(void) {
#ifdef _WIN32
  SwitchToThread();
#else
  sched_yield();
#endif
}

#endif
