#include "PagedInput.hpp"

#include <cmath>
#include <cstdint>
#include <string>

namespace margelo::nitro::narsil {

uint32_t pagedWhole(const jsi::Value& value) {
  if (!value.isNumber()) throwInvalid("A paged count must be a number");
  double number = value.getNumber();
  if (!std::isfinite(number) || number < 0 || number > UINT32_MAX || std::floor(number) != number) {
    throwInvalid("A paged count must be an unsigned 32-bit integer");
  }
  return static_cast<uint32_t>(number);
}

uint64_t pagedUint64(jsi::Runtime& runtime, const jsi::Value& value) {
  if (!value.isBigInt()) throwInvalid("A page position must be a bigint");
  auto number = value.getBigInt(runtime);
  if (!number.isUint64(runtime)) throwInvalid("A page position must be an unsigned 64-bit integer");
  return number.getUint64(runtime);
}

std::shared_ptr<PagedFileState> pagedFileState(jsi::Runtime& runtime, const jsi::Value& value) {
  if (!value.isObject()) throwInvalid("A paged file must be an open handle");
  auto object = value.getObject(runtime);
  if (!object.hasNativeState<PagedFileState>(runtime)) throwInvalid("A paged file has an invalid handle");
  return object.getNativeState<PagedFileState>(runtime);
}

void PagedSectionInput::prepare(jsi::Runtime& runtime, const jsi::Value& value) {
  if (!value.isObject()) throwInvalid("A page section must be an object");
  auto object = value.getObject(runtime);
  auto handle = object.getProperty(runtime, "file");
  _offset = pagedUint64(runtime, object.getProperty(runtime, "offset"));
  _length = pagedUint64(runtime, object.getProperty(runtime, "length"));
  _pageBytes = pagedWhole(object.getProperty(runtime, "pageBytes"));
  _regions.prepare(runtime, 0, object.getProperty(runtime, "checksums"));
  _state = pagedFileState(runtime, handle);
  file = _state->file;
  if (file == nullptr) throwInvalid("The paged file is closed");
}

narsil_page_section PagedSectionInput::read(jsi::Runtime& runtime) {
  if (_state->file == nullptr) throwInvalid("The paged file is closed");
  auto checksums = _regions.read<const uint8_t>(runtime, 0, "The page checksums");
  return {file.get(), _offset, _length, _pageBytes, checksums.data, checksums.length};
}

void PagedCacheInput::prepare(jsi::Runtime& runtime, const jsi::Value& value) {
  present = !value.isNull();
  if (!present) return;
  if (!value.isObject()) throwInvalid("A page cache must be an object");
  auto object = value.getObject(runtime);
  const char* keys[] = {"bytes", "files", "offsets", "pages", "lengths", "checksums"};
  for (size_t at = 0; at < 6; at++) _regions.prepare(runtime, at, object.getProperty(runtime, keys[at]));
}

void PagedCacheInput::retain(jsi::Runtime& runtime, std::vector<std::shared_ptr<ArrayBuffer>>& buffers) {
  if (!present) return;
  for (size_t at = 0; at < 6; at++) buffers.push_back(_regions.retainOwned(runtime, at));
}

narsil_page_cache PagedCacheInput::read(jsi::Runtime& runtime) {
  if (!present) return {};
  auto bytes = _regions.read<uint8_t>(runtime, 0, "The page bytes");
  auto files = _regions.read<uint64_t>(runtime, 1, "The cached file identities");
  auto offsets = _regions.read<uint64_t>(runtime, 2, "The cached section offsets");
  auto pages = _regions.read<uint64_t>(runtime, 3, "The cached page numbers");
  auto lengths = _regions.read<uint32_t>(runtime, 4, "The cached page lengths");
  auto checksums = _regions.read<uint32_t>(runtime, 5, "The cached checksums");
  if (files.length != offsets.length || files.length != pages.length || files.length != lengths.length ||
      files.length != checksums.length) throwInvalid("The cache metadata has unequal lengths");
  return {bytes.data, bytes.length, files.data, offsets.data, pages.data, lengths.data, checksums.data, files.length};
}

}
