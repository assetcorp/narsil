#pragma once

#include <NitroModules/ArrayBuffer.hpp>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>

namespace margelo::nitro::narsil {

class HostOwnedBuffer : public ArrayBuffer {
public:
  bool isOwner() const noexcept override { return true; }
  size_t getExternalMemorySize() const override { return 0; }
};

class ReservedRegion final : public HostOwnedBuffer {
public:
  ReservedRegion(uint8_t* data, size_t size, size_t mappedSize);
  ~ReservedRegion() override;
  uint8_t* data() override { return _data; }
  size_t size() const override { return _size; }

private:
  uint8_t* _data;
  size_t _size;
  size_t _mappedSize;
};

class AllocatedBuffer final : public HostOwnedBuffer {
public:
  AllocatedBuffer(uint8_t* data, size_t size);
  ~AllocatedBuffer() override;
  uint8_t* data() override { return _data; }
  size_t size() const override { return _size; }

private:
  uint8_t* _data;
  size_t _size;
};

std::shared_ptr<ArrayBuffer> reserveRegion(double bytes);
std::shared_ptr<ArrayBuffer> allocateZeroed(double bytes);
bool isHostOwned(const std::shared_ptr<ArrayBuffer>& buffer);

size_t requireByteCount(double value, const char* what);
uint8_t* bytesWithin(const std::shared_ptr<ArrayBuffer>& buffer, double byteOffset, double byteLength,
                     const char* what);

[[noreturn]] void throwSystemError(int number, const std::string& operation, const std::string& subject);
[[noreturn]] void throwInvalid(const std::string& message);

}
