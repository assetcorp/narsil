#pragma once

#include <NitroModules/ArrayBuffer.hpp>
#include <cstddef>
#include <cstdint>
#include <memory>

namespace margelo::nitro::narsil {

enum class CompressionFormat { RawDeflate, Gzip };

std::shared_ptr<ArrayBuffer> compressBytes(const uint8_t* source, size_t length, CompressionFormat format);
std::shared_ptr<ArrayBuffer> inflateBytes(const uint8_t* source, size_t length, CompressionFormat format,
                                          size_t maxLength);

}
