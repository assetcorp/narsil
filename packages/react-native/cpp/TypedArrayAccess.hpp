#pragma once

#include <jsi/jsi.h>

namespace margelo::nitro::narsil {

class TypedArrayAccess {
public:
  explicit TypedArrayAccess(jsi::Runtime& runtime) : TypedArrayAccess(runtime, prototypeOf(runtime)) {}

  jsi::Value kind(jsi::Runtime& runtime, const jsi::Object& value) const {
    return _kind.callWithThis(runtime, value);
  }

  jsi::Value buffer(jsi::Runtime& runtime, const jsi::Object& value) const {
    return _buffer.callWithThis(runtime, value);
  }

  jsi::Value byteOffset(jsi::Runtime& runtime, const jsi::Object& value) const {
    return _byteOffset.callWithThis(runtime, value);
  }

  jsi::Value length(jsi::Runtime& runtime, const jsi::Object& value) const {
    return _length.callWithThis(runtime, value);
  }

private:
  static jsi::Object prototypeOf(jsi::Runtime& runtime) {
    auto object = runtime.global().getPropertyAsObject(runtime, "Object");
    auto typed = runtime.global().getPropertyAsObject(runtime, "Uint8Array");
    return object.getPropertyAsFunction(runtime, "getPrototypeOf")
        .call(runtime, typed.getPropertyAsObject(runtime, "prototype")).asObject(runtime);
  }

  static jsi::Function getter(jsi::Runtime& runtime, const jsi::Object& prototype, const jsi::Value& property) {
    auto object = runtime.global().getPropertyAsObject(runtime, "Object");
    return object.getPropertyAsFunction(runtime, "getOwnPropertyDescriptor")
        .call(runtime, prototype, property).asObject(runtime).getPropertyAsFunction(runtime, "get");
  }

  TypedArrayAccess(jsi::Runtime& runtime, const jsi::Object& prototype)
      : _kind(getter(runtime, prototype,
                     runtime.global().getPropertyAsObject(runtime, "Symbol").getProperty(runtime, "toStringTag"))),
        _buffer(getter(runtime, prototype, jsi::String::createFromAscii(runtime, "buffer"))),
        _byteOffset(getter(runtime, prototype, jsi::String::createFromAscii(runtime, "byteOffset"))),
        _length(getter(runtime, prototype, jsi::String::createFromAscii(runtime, "length"))) {}

  jsi::Function _kind;
  jsi::Function _buffer;
  jsi::Function _byteOffset;
  jsi::Function _length;
};

}
