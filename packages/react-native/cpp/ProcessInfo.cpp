#include "ProcessInfo.hpp"
#include "HostMemory.hpp"

#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <sys/stat.h>
#include <unistd.h>

#if defined(__APPLE__)
#include <mach/mach.h>
#include <os/proc.h>
#elif defined(__ANDROID__)
#include "AndroidEnvironment.hpp"
#include <charconv>
#include <cstdint>
#include <fstream>
#include <limits>
#include <sstream>
#endif

namespace margelo::nitro::narsil {

namespace {

constexpr double UNKNOWN_BYTES = -1;

void makeDirectoryIfMissing(const std::string& path) {
  if (mkdir(path.c_str(), 0700) != 0 && errno != EEXIST) throwSystemError(errno, "create the directory", path);
}

}

#if defined(__APPLE__)

double residentBytesOfThisProcess() {
  task_vm_info_data_t info{};
  mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
  if (task_info(mach_task_self(), TASK_VM_INFO, reinterpret_cast<task_info_t>(&info), &count) != KERN_SUCCESS) {
    return UNKNOWN_BYTES;
  }
  return static_cast<double>(info.phys_footprint);
}

double availableBytesForThisProcess() { return static_cast<double>(os_proc_available_memory()); }

std::string privateStorageDirectory() {
  const char* home = std::getenv("HOME");
  if (home == nullptr || home[0] == '\0') throwSystemError(ENOENT, "find the app's home directory", "HOME");
  std::string library = std::string(home) + "/Library";
  std::string support = library + "/Application Support";
  makeDirectoryIfMissing(library);
  makeDirectoryIfMissing(support);
  return support;
}

#elif defined(__ANDROID__)

constexpr uint64_t KIBIBYTE_BYTES = 1024;

double wholeResidentBytes() {
  std::ifstream statm("/proc/self/statm");
  double totalPages = 0;
  double residentPages = 0;
  if (!(statm >> totalPages >> residentPages)) return UNKNOWN_BYTES;
  long page = sysconf(_SC_PAGESIZE);
  return residentPages * static_cast<double>(page > 0 ? page : 4096);
}

double residentBytesOfThisProcess() {
  std::ifstream status("/proc/self/status");
  uint64_t anonymousKibibytes = 0;
  uint64_t sharedKibibytes = 0;
  bool hasAnonymous = false;
  bool hasShared = false;
  std::string line;
  while (std::getline(status, line)) {
    std::istringstream fields(line);
    std::string field, digits, unit, extra;
    if (!(fields >> field) || (field != "RssAnon:" && field != "RssShmem:")) continue;
    if (!(fields >> digits >> unit) || unit != "kB" || (fields >> extra)) return wholeResidentBytes();
    uint64_t value = 0;
    const auto parsed = std::from_chars(digits.data(), digits.data() + digits.size(), value);
    if (parsed.ec != std::errc{} || parsed.ptr != digits.data() + digits.size()) return wholeResidentBytes();
    if (field == "RssAnon:") {
      anonymousKibibytes = value;
      hasAnonymous = true;
    } else {
      sharedKibibytes = value;
      hasShared = true;
    }
  }
  const uint64_t largestKibibytes = std::numeric_limits<uint64_t>::max() / KIBIBYTE_BYTES;
  if (!status.bad() && hasAnonymous && hasShared && anonymousKibibytes <= largestKibibytes &&
      sharedKibibytes <= largestKibibytes - anonymousKibibytes) {
    return static_cast<double>((anonymousKibibytes + sharedKibibytes) * KIBIBYTE_BYTES);
  }
  return wholeResidentBytes();
}

double availableBytesForThisProcess() { return androidAvailableBytes(); }

std::string privateStorageDirectory() {
  std::string files = androidFilesDirectory();
  if (files.empty()) throwSystemError(ENOENT, "find the app's private directory", "Context.getFilesDir()");
  makeDirectoryIfMissing(files);
  return files;
}

#else

double residentBytesOfThisProcess() { return UNKNOWN_BYTES; }
double availableBytesForThisProcess() { return UNKNOWN_BYTES; }
std::string privateStorageDirectory() { throwSystemError(ENOTSUP, "find the app's private directory", ""); }

#endif

}
