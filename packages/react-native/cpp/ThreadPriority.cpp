#include "ThreadPriority.hpp"

#include <cmath>

#if defined(__APPLE__)
#include <pthread.h>
#include <pthread/qos.h>
#elif defined(__ANDROID__)
#include <sys/resource.h>
#include <unistd.h>
#endif

namespace margelo::nitro::narsil {

namespace {

bool isWholeNumber(double value) { return std::isfinite(value) && std::trunc(value) == value; }

}

#if defined(__APPLE__)

namespace {

constexpr int HIGHEST_ENGINE_SERVICE_CLASS = static_cast<int>(QOS_CLASS_USER_INITIATED);

bool isServiceClass(int value) {
  switch (value) {
  case QOS_CLASS_USER_INTERACTIVE:
  case QOS_CLASS_USER_INITIATED:
  case QOS_CLASS_DEFAULT:
  case QOS_CLASS_UTILITY:
  case QOS_CLASS_BACKGROUND:
    return true;
  default:
    return false;
  }
}

}

double priorityOfThisThread() { return static_cast<double>(qos_class_self()); }

bool adoptAppThreadPriority(double appThreadPriority) {
  if (!isWholeNumber(appThreadPriority)) return false;
  int serviceClass = static_cast<int>(appThreadPriority);
  if (!isServiceClass(serviceClass)) return false;
  if (serviceClass > HIGHEST_ENGINE_SERVICE_CLASS) serviceClass = HIGHEST_ENGINE_SERVICE_CLASS;
  return pthread_set_qos_class_self_np(static_cast<qos_class_t>(serviceClass), 0) == 0;
}

#elif defined(__ANDROID__)

namespace {

constexpr int HIGHEST_NICE = -20;
constexpr int LOWEST_NICE = 19;

}

double priorityOfThisThread() { return static_cast<double>(getpriority(PRIO_PROCESS, static_cast<id_t>(gettid()))); }

bool adoptAppThreadPriority(double appThreadPriority) {
  if (!isWholeNumber(appThreadPriority)) return false;
  if (appThreadPriority < HIGHEST_NICE || appThreadPriority > LOWEST_NICE) return false;
  return setpriority(PRIO_PROCESS, static_cast<id_t>(gettid()), static_cast<int>(appThreadPriority)) == 0;
}

#else

double priorityOfThisThread() { return NAN; }

bool adoptAppThreadPriority(double) { return false; }

#endif

}
