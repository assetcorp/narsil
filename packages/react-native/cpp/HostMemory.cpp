#include "HostMemory.hpp"

#include <cerrno>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <stdexcept>
#include <sys/mman.h>
#include <unistd.h>

namespace margelo::nitro::narsil {

namespace {

constexpr double LARGEST_EXACT_BYTE_COUNT = 9007199254740991.0;

const char* errorName(int number) {
  switch (number) {
    case ENOENT: return "ENOENT";
    case EEXIST: return "EEXIST";
    case EISDIR: return "EISDIR";
    case ENOTDIR: return "ENOTDIR";
    case EACCES: return "EACCES";
    case EPERM: return "EPERM";
    case EINVAL: return "EINVAL";
    case ENOTSUP: return "ENOTSUP";
    case ENOSPC: return "ENOSPC";
    case EIO: return "EIO";
    case EBADF: return "EBADF";
    case ENOTEMPTY: return "ENOTEMPTY";
    case EXDEV: return "EXDEV";
    case EMFILE: return "EMFILE";
    case ENFILE: return "ENFILE";
    case EROFS: return "EROFS";
    case EBUSY: return "EBUSY";
    case ENAMETOOLONG: return "ENAMETOOLONG";
    case ELOOP: return "ELOOP";
    case EAGAIN: return "EAGAIN";
    case EFBIG: return "EFBIG";
    case EDQUOT: return "EDQUOT";
    case ENOMEM: return "ENOMEM";
    case ESRCH: return "ESRCH";
    default: return "EUNKNOWN";
  }
}

size_t pageBytes() {
  long page = sysconf(_SC_PAGESIZE);
  return page > 0 ? static_cast<size_t>(page) : 4096;
}

}

ReservedRegion::ReservedRegion(uint8_t* data, size_t size, size_t mappedSize)
    : _data(data), _size(size), _mappedSize(mappedSize) {}

ReservedRegion::~ReservedRegion() { munmap(_data, _mappedSize); }

AllocatedBuffer::AllocatedBuffer(uint8_t* data, size_t size) : _data(data), _size(size) {}

AllocatedBuffer::~AllocatedBuffer() { std::free(_data); }

void throwSystemError(int number, const std::string& operation, const std::string& subject) {
  std::string message = std::string("[") + errorName(number) + "] " + operation;
  if (!subject.empty()) message += " '" + subject + "'";
  message += ": ";
  message += std::strerror(number);
  throw std::runtime_error(message);
}

void throwInvalid(const std::string& message) { throw std::invalid_argument("[EINVAL] " + message); }

size_t requireByteCount(double value, const char* what) {
  if (!std::isfinite(value) || value < 0 || value > LARGEST_EXACT_BYTE_COUNT || std::floor(value) != value) {
    throwInvalid(std::string(what) + " must be a whole number of bytes from 0 up");
  }
  return static_cast<size_t>(value);
}

uint8_t* bytesWithin(const std::shared_ptr<ArrayBuffer>& buffer, double byteOffset, double byteLength,
                     const char* what) {
  if (buffer == nullptr) throwInvalid(std::string(what) + " has no buffer");
  size_t offset = requireByteCount(byteOffset, what);
  size_t length = requireByteCount(byteLength, what);
  size_t held = buffer->size();
  if (offset > held || length > held - offset) {
    throwInvalid(std::string(what) + " reaches past the end of its buffer");
  }
  uint8_t* base = buffer->data();
  if (base == nullptr) {
    if (length == 0) return nullptr;
    throwInvalid(std::string(what) + " has a detached buffer");
  }
  return base + offset;
}

std::shared_ptr<ArrayBuffer> reserveRegion(double bytes) {
  size_t size = requireByteCount(bytes, "A reservation");
  if (size == 0) throwInvalid("A reservation needs at least one byte");
  size_t page = pageBytes();
  if (size > SIZE_MAX - page) throwSystemError(ENOMEM, "reserve memory", std::to_string(size) + " bytes");
  size_t mapped = (size + page - 1) / page * page;
  int flags = MAP_PRIVATE | MAP_ANON;
#ifdef MAP_NORESERVE
  flags |= MAP_NORESERVE;
#endif
  void* address = mmap(nullptr, mapped, PROT_READ | PROT_WRITE, flags, -1, 0);
  if (address == MAP_FAILED) throwSystemError(errno, "reserve memory", std::to_string(size) + " bytes");
  return std::make_shared<ReservedRegion>(static_cast<uint8_t*>(address), size, mapped);
}

std::shared_ptr<ArrayBuffer> allocateZeroed(double bytes) {
  size_t size = requireByteCount(bytes, "An allocation");
  void* data = std::calloc(size == 0 ? 1 : size, 1);
  if (data == nullptr) throwSystemError(ENOMEM, "allocate memory", std::to_string(size) + " bytes");
  return std::make_shared<AllocatedBuffer>(static_cast<uint8_t*>(data), size);
}

bool isHostOwned(const std::shared_ptr<ArrayBuffer>& buffer) {
  return std::dynamic_pointer_cast<HostOwnedBuffer>(buffer) != nullptr;
}

}
