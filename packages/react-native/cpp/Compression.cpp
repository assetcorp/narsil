#include "Compression.hpp"
#include "HostMemory.hpp"

#include <algorithm>
#include <cerrno>
#include <climits>
#include <string>
#include <vector>
#include <zlib.h>

namespace margelo::nitro::narsil {

namespace {

constexpr int RAW_DEFLATE_WINDOW_BITS = -15;
constexpr int GZIP_WINDOW_BITS = 31;
constexpr int DEFAULT_MEMORY_LEVEL = 8;
constexpr size_t LARGEST_ZLIB_STEP = static_cast<size_t>(UINT_MAX);
constexpr size_t FIRST_INFLATE_CAPACITY = 64 * 1024;

int windowBitsOf(CompressionFormat format) {
  return format == CompressionFormat::Gzip ? GZIP_WINDOW_BITS : RAW_DEFLATE_WINDOW_BITS;
}

uInt stepOf(size_t remaining) { return static_cast<uInt>(std::min(remaining, LARGEST_ZLIB_STEP)); }

class DeflateStream {
public:
  explicit DeflateStream(CompressionFormat format) {
    if (deflateInit2(&stream, Z_DEFAULT_COMPRESSION, Z_DEFLATED, windowBitsOf(format), DEFAULT_MEMORY_LEVEL,
                     Z_DEFAULT_STRATEGY) != Z_OK) {
      throwSystemError(ENOMEM, "start compression", "");
    }
  }
  ~DeflateStream() { deflateEnd(&stream); }
  z_stream stream{};
};

class InflateStream {
public:
  explicit InflateStream(CompressionFormat format) {
    if (inflateInit2(&stream, windowBitsOf(format)) != Z_OK) throwSystemError(ENOMEM, "start decompression", "");
  }
  ~InflateStream() { inflateEnd(&stream); }
  z_stream stream{};
};

}

std::shared_ptr<ArrayBuffer> compressBytes(const uint8_t* source, size_t length, CompressionFormat format) {
  DeflateStream deflater(format);
  z_stream& stream = deflater.stream;
  std::vector<uint8_t> output(static_cast<size_t>(deflateBound(&stream, static_cast<uLong>(length))) + 64);
  size_t consumed = 0;
  size_t produced = 0;
  int status = Z_OK;
  while (status != Z_STREAM_END) {
    size_t remainingInput = length - consumed;
    if (output.size() == produced) output.resize(output.size() * 2);
    stream.next_in = const_cast<Bytef*>(source + consumed);
    stream.avail_in = stepOf(remainingInput);
    stream.next_out = output.data() + produced;
    stream.avail_out = stepOf(output.size() - produced);
    uInt offeredIn = stream.avail_in;
    uInt offeredOut = stream.avail_out;
    bool lastStep = offeredIn == remainingInput;
    status = deflate(&stream, lastStep ? Z_FINISH : Z_NO_FLUSH);
    if (status == Z_STREAM_ERROR) throwInvalid("The compressor rejected its input");
    consumed += offeredIn - stream.avail_in;
    produced += offeredOut - stream.avail_out;
  }
  output.resize(produced);
  return ArrayBuffer::move(std::move(output));
}

std::shared_ptr<ArrayBuffer> inflateBytes(const uint8_t* source, size_t length, CompressionFormat format,
                                          size_t maxLength) {
  InflateStream inflater(format);
  z_stream& stream = inflater.stream;
  size_t capacityLimit = maxLength + 1;
  std::vector<uint8_t> output(std::min(capacityLimit, std::max(FIRST_INFLATE_CAPACITY, length * 4)));
  size_t consumed = 0;
  size_t produced = 0;
  for (;;) {
    if (produced > maxLength) throwSystemError(EFBIG, "decompress past " + std::to_string(maxLength) + " bytes", "");
    if (produced == output.size()) output.resize(std::min(capacityLimit, output.size() * 2));
    stream.next_in = const_cast<Bytef*>(source + consumed);
    stream.avail_in = stepOf(length - consumed);
    stream.next_out = output.data() + produced;
    stream.avail_out = stepOf(output.size() - produced);
    uInt offeredIn = stream.avail_in;
    uInt offeredOut = stream.avail_out;
    int status = inflate(&stream, Z_NO_FLUSH);
    consumed += offeredIn - stream.avail_in;
    produced += offeredOut - stream.avail_out;
    if (status == Z_STREAM_END) {
      if (consumed != length) throwInvalid("The compressed data carries bytes after its end");
      break;
    }
    if (status == Z_NEED_DICT || status == Z_DATA_ERROR || status == Z_STREAM_ERROR) {
      throwInvalid("The compressed data is corrupt");
    }
    if (status == Z_MEM_ERROR) throwSystemError(ENOMEM, "decompress", "");
    bool madeProgress = offeredIn != stream.avail_in || offeredOut != stream.avail_out;
    if (consumed == length && produced < output.size()) throwInvalid("The compressed data ends early");
    if (!madeProgress && produced < output.size()) throwInvalid("The compressed data ends early");
  }
  if (produced > maxLength) throwSystemError(EFBIG, "decompress past " + std::to_string(maxLength) + " bytes", "");
  output.resize(produced);
  return ArrayBuffer::move(std::move(output));
}

}
