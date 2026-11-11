#pragma once

#include "HostMemory.hpp"
#include "TypedArrayAccess.hpp"
#include <NitroModules/JSIConverter.hpp>

#include <jsi/jsi.h>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <type_traits>
#include <vector>

namespace margelo::nitro::narsil {

template <typename Element>
struct Elements {
  Element* data;
  uint32_t length;
};

class TypedElements {
public:
  explicit TypedElements(size_t count) : _regions(count) {}

  void prepare(jsi::Runtime& runtime, size_t index, const jsi::Value& value) {
    if (!value.isObject()) throwInvalid("A typed array must be an object");
    if (!_access) _access.emplace(runtime);
    jsi::Object object = value.getObject(runtime);
    jsi::Value kind = _access->kind(runtime, object);
    if (!kind.isString()) throwInvalid("A typed array must have a typed-array kind");
    std::string name = kind.getString(runtime).utf8(runtime);
    jsi::Value held = _access->buffer(runtime, object);
    if (!held.isObject() || !held.getObject(runtime).isArrayBuffer(runtime)) {
      throwInvalid("A typed array must hold an ArrayBuffer");
    }
    jsi::ArrayBuffer buffer = held.getObject(runtime).getArrayBuffer(runtime);
    size_t offset = wholeValue(_access->byteOffset(runtime, object), "byteOffset");
    size_t length = wholeValue(_access->length(runtime, object), "length");
    if (length > UINT32_MAX) throwInvalid("A typed array has an invalid element count");
    _regions.at(index).emplace(Region{std::move(buffer), offset, static_cast<uint32_t>(length), std::move(name)});
  }

  template <typename Element>
  Elements<Element> read(jsi::Runtime& runtime, size_t index, const char* what) {
    auto& held = _regions.at(index);
    if (!held || held->kind != kindOf<Element>()) throwInvalid(std::string(what) + " has the wrong element type");
    Region& region = *held;
    if (region.length > SIZE_MAX / sizeof(Element)) throwInvalid(std::string(what) + " has too many elements");
    size_t bytes = static_cast<size_t>(region.length) * sizeof(Element);
    size_t size = region.buffer.size(runtime);
    if (region.offset > size || bytes > size - region.offset) {
      throwInvalid(std::string(what) + " reaches past its buffer");
    }
    uint8_t* base = region.buffer.data(runtime);
    if (base == nullptr) {
      if (bytes > 0) throwInvalid(std::string(what) + " has no buffer data");
      return {nullptr, 0};
    }
    uint8_t* start = base + region.offset;
    if (reinterpret_cast<uintptr_t>(start) % alignof(Element) != 0) throwInvalid(std::string(what) + " is misaligned");
    return {reinterpret_cast<Element*>(start), region.length};
  }

  std::shared_ptr<ArrayBuffer> retainOwned(jsi::Runtime& runtime, size_t index) {
    auto& held = _regions.at(index);
    if (!held) throwInvalid("An asynchronous region has no buffer");
    auto buffer = JSIConverter<std::shared_ptr<ArrayBuffer>>::fromJSI(runtime, jsi::Value(runtime, held->buffer));
    if (!isHostOwned(buffer)) throwInvalid("An asynchronous region must use host-owned memory");
    return buffer;
  }

private:
  struct Region {
    jsi::ArrayBuffer buffer;
    size_t offset;
    uint32_t length;
    std::string kind;
  };

  template <typename Element>
  static const char* kindOf() {
    using Value = std::remove_const_t<Element>;
    if constexpr (std::is_same_v<Value, uint8_t>) return "Uint8Array";
    if constexpr (std::is_same_v<Value, uint16_t>) return "Uint16Array";
    if constexpr (std::is_same_v<Value, uint32_t>) return "Uint32Array";
    if constexpr (std::is_same_v<Value, uint64_t>) return "BigUint64Array";
    if constexpr (std::is_same_v<Value, int64_t>) return "BigInt64Array";
    if constexpr (std::is_same_v<Value, int32_t>) return "Int32Array";
    if constexpr (std::is_same_v<Value, double>) return "Float64Array";
    if constexpr (std::is_same_v<Value, float>) return "Float32Array";
    return "";
  }

  static size_t wholeValue(const jsi::Value& value, const char* name) {
    if (!value.isNumber()) throwInvalid(std::string(name) + " must be a number");
    double number = value.getNumber();
    if (!std::isfinite(number) || number < 0 || std::floor(number) != number ||
        (sizeof(size_t) > sizeof(uint32_t) ? number >= static_cast<double>(SIZE_MAX)
                                         : number > static_cast<double>(SIZE_MAX))) {
      throwInvalid(std::string(name) + " must be a representable whole number");
    }
    return static_cast<size_t>(number);
  }

  std::vector<std::optional<Region>> _regions;
  std::optional<TypedArrayAccess> _access;
};

}
