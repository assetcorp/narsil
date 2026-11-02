#include "HybridNarsilFilesImpl.hpp"
#include "HostMemory.hpp"

#include <cerrno>
#include <cmath>
#include <cstdint>
#include <dirent.h>
#include <fcntl.h>
#include <string>
#include <sys/stat.h>
#include <unistd.h>
#include <vector>

namespace margelo::nitro::narsil {

namespace {

constexpr mode_t PRIVATE_FILE_MODE = 0600;
constexpr mode_t PRIVATE_DIRECTORY_MODE = 0700;
constexpr double CURRENT_POSITION = -1;

int openFlagsOf(const std::string& flags) {
  if (flags == "r") return O_RDONLY;
  if (flags == "r+") return O_RDWR;
  if (flags == "w") return O_WRONLY | O_CREAT | O_TRUNC;
  if (flags == "wx") return O_WRONLY | O_CREAT | O_EXCL;
  if (flags == "w+") return O_RDWR | O_CREAT | O_TRUNC;
  if (flags == "wx+") return O_RDWR | O_CREAT | O_EXCL;
  if (flags == "a") return O_WRONLY | O_CREAT | O_APPEND;
  if (flags == "a+") return O_RDWR | O_CREAT | O_APPEND;
  throwInvalid("A file opens with r, r+, w, wx, w+, wx+, a, or a+, not " + flags);
}

int descriptorOf(double value) {
  if (!std::isfinite(value) || value < 0 || value > INT32_MAX || std::floor(value) != value) {
    throwSystemError(EBADF, "use the file descriptor", "");
  }
  return static_cast<int>(value);
}

void requirePath(const std::string& path) {
  if (path.empty() || path.find('\0') != std::string::npos) throwInvalid("A path must be non-empty text without NUL");
}

double millisecondsOf(const struct timespec& time) {
  return static_cast<double>(time.tv_sec) * 1000 + static_cast<double>(time.tv_nsec) / 1e6;
}

FileStatus statusOf(const struct stat& status) {
#if defined(__APPLE__)
  double modifiedMs = millisecondsOf(status.st_mtimespec);
#else
  double modifiedMs = millisecondsOf(status.st_mtim);
#endif
  return FileStatus(static_cast<double>(status.st_size), S_ISDIR(status.st_mode), S_ISREG(status.st_mode),
                    std::to_string(static_cast<uint64_t>(status.st_dev)),
                    std::to_string(static_cast<uint64_t>(status.st_ino)), modifiedMs);
}

void syncDescriptor(int descriptor) {
#if defined(__APPLE__)
  if (fcntl(descriptor, F_FULLFSYNC) == 0) return;
  if (errno != ENOTSUP && errno != EINVAL && errno != ENOTTY) throwSystemError(errno, "flush the file", "");
#endif
  int result = 0;
  do {
    result = fsync(descriptor);
  } while (result != 0 && errno == EINTR);
  if (result != 0) throwSystemError(errno, "flush the file", "");
}

}

double HybridNarsilFilesImpl::open(const std::string& path, const std::string& flags) {
  requirePath(path);
  int mode = openFlagsOf(flags) | O_CLOEXEC;
  int descriptor = -1;
  do {
    descriptor = ::open(path.c_str(), mode, PRIVATE_FILE_MODE);
  } while (descriptor < 0 && errno == EINTR);
  if (descriptor < 0) throwSystemError(errno, "open", path);
  return static_cast<double>(descriptor);
}

void HybridNarsilFilesImpl::close(double descriptor) {
  if (::close(descriptorOf(descriptor)) != 0 && errno != EINTR) throwSystemError(errno, "close the file", "");
}

double HybridNarsilFilesImpl::read(double descriptor, const std::shared_ptr<ArrayBuffer>& target, double byteOffset,
                                   double byteLength, double position) {
  int file = descriptorOf(descriptor);
  uint8_t* bytes = bytesWithin(target, byteOffset, byteLength, "The read target");
  size_t length = static_cast<size_t>(byteLength);
  if (length == 0) return 0;
  ssize_t count = -1;
  do {
    count = position == CURRENT_POSITION
                ? ::read(file, bytes, length)
                : pread(file, bytes, length, static_cast<off_t>(requireByteCount(position, "A read position")));
  } while (count < 0 && errno == EINTR);
  if (count < 0) throwSystemError(errno, "read the file", "");
  return static_cast<double>(count);
}

double HybridNarsilFilesImpl::write(double descriptor, const std::shared_ptr<ArrayBuffer>& source, double byteOffset,
                                    double byteLength, double position) {
  int file = descriptorOf(descriptor);
  uint8_t* bytes = bytesWithin(source, byteOffset, byteLength, "The write source");
  size_t length = static_cast<size_t>(byteLength);
  if (length == 0) return 0;
  ssize_t count = -1;
  do {
    count = position == CURRENT_POSITION
                ? ::write(file, bytes, length)
                : pwrite(file, bytes, length, static_cast<off_t>(requireByteCount(position, "A write position")));
  } while (count < 0 && errno == EINTR);
  if (count < 0) throwSystemError(errno, "write the file", "");
  return static_cast<double>(count);
}

void HybridNarsilFilesImpl::sync(double descriptor) { syncDescriptor(descriptorOf(descriptor)); }

std::shared_ptr<Promise<std::shared_ptr<ArrayBuffer>>>
HybridNarsilFilesImpl::readAsync(double descriptor, double byteLength, double position) {
  int file = descriptorOf(descriptor);
  size_t length = requireByteCount(byteLength, "A read length");
  bool atCurrentPosition = position == CURRENT_POSITION;
  off_t offset = atCurrentPosition ? 0 : static_cast<off_t>(requireByteCount(position, "A read position"));
  return Promise<std::shared_ptr<ArrayBuffer>>::async([file, length, atCurrentPosition, offset]() {
    std::vector<uint8_t> bytes(length);
    ssize_t count = 0;
    if (length > 0) {
      do {
        count = atCurrentPosition ? ::read(file, bytes.data(), length) : pread(file, bytes.data(), length, offset);
      } while (count < 0 && errno == EINTR);
      if (count < 0) throwSystemError(errno, "read the file", "");
    }
    bytes.resize(static_cast<size_t>(count));
    return ArrayBuffer::move(std::move(bytes));
  });
}

std::shared_ptr<Promise<double>> HybridNarsilFilesImpl::writeAsync(double descriptor,
                                                                   const std::shared_ptr<ArrayBuffer>& source,
                                                                   double byteOffset, double byteLength,
                                                                   double position) {
  int file = descriptorOf(descriptor);
  uint8_t* start = bytesWithin(source, byteOffset, byteLength, "The write source");
  size_t length = static_cast<size_t>(byteLength);
  bool atCurrentPosition = position == CURRENT_POSITION;
  off_t offset = atCurrentPosition ? 0 : static_cast<off_t>(requireByteCount(position, "A write position"));
  auto bytes = std::make_shared<std::vector<uint8_t>>(start, start + length);
  return Promise<double>::async([file, bytes, atCurrentPosition, offset]() {
    if (bytes->empty()) return 0.0;
    ssize_t count = -1;
    do {
      count = atCurrentPosition ? ::write(file, bytes->data(), bytes->size())
                                : pwrite(file, bytes->data(), bytes->size(), offset);
    } while (count < 0 && errno == EINTR);
    if (count < 0) throwSystemError(errno, "write the file", "");
    return static_cast<double>(count);
  });
}

std::shared_ptr<Promise<void>> HybridNarsilFilesImpl::syncAsync(double descriptor) {
  int file = descriptorOf(descriptor);
  return Promise<void>::async([file]() { syncDescriptor(file); });
}

void HybridNarsilFilesImpl::truncate(double descriptor, double byteLength) {
  off_t length = static_cast<off_t>(requireByteCount(byteLength, "A file length"));
  if (ftruncate(descriptorOf(descriptor), length) != 0) throwSystemError(errno, "truncate the file", "");
}

FileStatus HybridNarsilFilesImpl::descriptorStatus(double descriptor) {
  struct stat status {};
  if (fstat(descriptorOf(descriptor), &status) != 0) throwSystemError(errno, "read the file's status", "");
  return statusOf(status);
}

FileStatus HybridNarsilFilesImpl::pathStatus(const std::string& path) {
  requirePath(path);
  struct stat status {};
  if (stat(path.c_str(), &status) != 0) throwSystemError(errno, "stat", path);
  return statusOf(status);
}

void HybridNarsilFilesImpl::makeDirectory(const std::string& path) {
  requirePath(path);
  if (mkdir(path.c_str(), PRIVATE_DIRECTORY_MODE) != 0) throwSystemError(errno, "mkdir", path);
}

std::vector<DirectoryEntry> HybridNarsilFilesImpl::readDirectory(const std::string& path) {
  requirePath(path);
  DIR* directory = opendir(path.c_str());
  if (directory == nullptr) throwSystemError(errno, "scandir", path);
  std::vector<DirectoryEntry> entries;
  errno = 0;
  while (struct dirent* entry = readdir(directory)) {
    std::string name = entry->d_name;
    if (name == "." || name == "..") continue;
    bool isDirectory = entry->d_type == DT_DIR;
    bool isFile = entry->d_type == DT_REG;
    if (entry->d_type == DT_UNKNOWN) {
      struct stat status {};
      std::string full = path + "/" + name;
      if (lstat(full.c_str(), &status) == 0) {
        isDirectory = S_ISDIR(status.st_mode);
        isFile = S_ISREG(status.st_mode);
      }
    }
    entries.emplace_back(name, isDirectory, isFile);
    errno = 0;
  }
  int failure = errno;
  closedir(directory);
  if (failure != 0) throwSystemError(failure, "scandir", path);
  return entries;
}

void HybridNarsilFilesImpl::rename(const std::string& from, const std::string& to) {
  requirePath(from);
  requirePath(to);
  if (::rename(from.c_str(), to.c_str()) != 0) throwSystemError(errno, "rename", from + "' -> '" + to);
}

void HybridNarsilFilesImpl::unlink(const std::string& path) {
  requirePath(path);
  if (::unlink(path.c_str()) != 0) throwSystemError(errno, "unlink", path);
}

void HybridNarsilFilesImpl::removeDirectory(const std::string& path) {
  requirePath(path);
  if (rmdir(path.c_str()) != 0) throwSystemError(errno, "rmdir", path);
}

void HybridNarsilFilesImpl::link(const std::string& existingPath, const std::string& newPath) {
  requirePath(existingPath);
  requirePath(newPath);
  if (::link(existingPath.c_str(), newPath.c_str()) != 0) {
    throwSystemError(errno, "link", existingPath + "' -> '" + newPath);
  }
}

}
