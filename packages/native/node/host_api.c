#include "host_api.h"

#ifdef _WIN32

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <windows.h>

enum {
  HOST_ADJUST_EXTERNAL_MEMORY,
  HOST_CREATE_DOUBLE,
  HOST_CREATE_EXTERNAL,
  HOST_CREATE_INT32,
  HOST_CREATE_REFERENCE,
  HOST_DEFINE_PROPERTIES,
  HOST_DELETE_REFERENCE,
  HOST_GET_ARRAY_LENGTH,
  HOST_GET_CB_INFO,
  HOST_GET_ELEMENT,
  HOST_GET_INSTANCE_DATA,
  HOST_GET_NAMED_PROPERTY,
  HOST_GET_TYPEDARRAY_INFO,
  HOST_GET_VALUE_EXTERNAL,
  HOST_GET_VALUE_INT32,
  HOST_GET_VALUE_UINT32,
  HOST_IS_TYPEDARRAY,
  HOST_SET_INSTANCE_DATA,
  HOST_THROW_ERROR,
  HOST_TYPEOF,
  HOST_FUNCTION_COUNT
};

static const char *const HOST_FUNCTION_NAMES[HOST_FUNCTION_COUNT] = {
    [HOST_ADJUST_EXTERNAL_MEMORY] = "napi_adjust_external_memory",
    [HOST_CREATE_DOUBLE] = "napi_create_double",
    [HOST_CREATE_EXTERNAL] = "napi_create_external",
    [HOST_CREATE_INT32] = "napi_create_int32",
    [HOST_CREATE_REFERENCE] = "napi_create_reference",
    [HOST_DEFINE_PROPERTIES] = "napi_define_properties",
    [HOST_DELETE_REFERENCE] = "napi_delete_reference",
    [HOST_GET_ARRAY_LENGTH] = "napi_get_array_length",
    [HOST_GET_CB_INFO] = "napi_get_cb_info",
    [HOST_GET_ELEMENT] = "napi_get_element",
    [HOST_GET_INSTANCE_DATA] = "napi_get_instance_data",
    [HOST_GET_NAMED_PROPERTY] = "napi_get_named_property",
    [HOST_GET_TYPEDARRAY_INFO] = "napi_get_typedarray_info",
    [HOST_GET_VALUE_EXTERNAL] = "napi_get_value_external",
    [HOST_GET_VALUE_INT32] = "napi_get_value_int32",
    [HOST_GET_VALUE_UINT32] = "napi_get_value_uint32",
    [HOST_IS_TYPEDARRAY] = "napi_is_typedarray",
    [HOST_SET_INSTANCE_DATA] = "napi_set_instance_data",
    [HOST_THROW_ERROR] = "napi_throw_error",
    [HOST_TYPEOF] = "napi_typeof",
};

static const char *const LIBRARIES_THAT_EMBED_NODE[] = {"libnode.dll", "node.dll"};

static FARPROC host_functions[HOST_FUNCTION_COUNT];
static INIT_ONCE host_functions_resolved = INIT_ONCE_STATIC_INIT;

#define HOST_FUNCTION(slot, function) ((__typeof__(function) *)(void (*)(void))host_functions[(slot)])

static BOOL resolve_from(HMODULE module) {
  if (module == NULL) { return FALSE; }
  FARPROC resolved[HOST_FUNCTION_COUNT];
  for (size_t slot = 0; slot < HOST_FUNCTION_COUNT; slot++) {
    resolved[slot] = GetProcAddress(module, HOST_FUNCTION_NAMES[slot]);
    if (resolved[slot] == NULL) { return FALSE; }
  }
  for (size_t slot = 0; slot < HOST_FUNCTION_COUNT; slot++) { host_functions[slot] = resolved[slot]; }
  return TRUE;
}

static BOOL CALLBACK resolve_host_functions(PINIT_ONCE once, PVOID parameter, PVOID *context) {
  (void)once;
  (void)parameter;
  (void)context;
  if (resolve_from(GetModuleHandleA(NULL))) { return TRUE; }
  for (size_t index = 0; index < sizeof LIBRARIES_THAT_EMBED_NODE / sizeof LIBRARIES_THAT_EMBED_NODE[0]; index++) {
    if (resolve_from(GetModuleHandleA(LIBRARIES_THAT_EMBED_NODE[index]))) { return TRUE; }
  }
  return FALSE;
}

int host_api_ready(void) {
  return InitOnceExecuteOnce(&host_functions_resolved, resolve_host_functions, NULL, NULL) != FALSE;
}

napi_status NAPI_CDECL napi_adjust_external_memory(node_api_basic_env env, int64_t change_in_bytes,
                                                   int64_t *adjusted_value) {
  return HOST_FUNCTION(HOST_ADJUST_EXTERNAL_MEMORY, napi_adjust_external_memory)(env, change_in_bytes, adjusted_value);
}

napi_status NAPI_CDECL napi_create_double(napi_env env, double value, napi_value *result) {
  return HOST_FUNCTION(HOST_CREATE_DOUBLE, napi_create_double)(env, value, result);
}

napi_status NAPI_CDECL napi_create_external(napi_env env, void *data, node_api_basic_finalize finalize_cb,
                                            void *finalize_hint, napi_value *result) {
  return HOST_FUNCTION(HOST_CREATE_EXTERNAL, napi_create_external)(env, data, finalize_cb, finalize_hint, result);
}

napi_status NAPI_CDECL napi_create_int32(napi_env env, int32_t value, napi_value *result) {
  return HOST_FUNCTION(HOST_CREATE_INT32, napi_create_int32)(env, value, result);
}

napi_status NAPI_CDECL napi_create_reference(napi_env env, napi_value value, uint32_t initial_refcount,
                                             napi_ref *result) {
  return HOST_FUNCTION(HOST_CREATE_REFERENCE, napi_create_reference)(env, value, initial_refcount, result);
}

napi_status NAPI_CDECL napi_define_properties(napi_env env, napi_value object, size_t property_count,
                                              const napi_property_descriptor *properties) {
  return HOST_FUNCTION(HOST_DEFINE_PROPERTIES, napi_define_properties)(env, object, property_count, properties);
}

napi_status NAPI_CDECL napi_delete_reference(node_api_basic_env env, napi_ref ref) {
  return HOST_FUNCTION(HOST_DELETE_REFERENCE, napi_delete_reference)(env, ref);
}

napi_status NAPI_CDECL napi_get_array_length(napi_env env, napi_value value, uint32_t *result) {
  return HOST_FUNCTION(HOST_GET_ARRAY_LENGTH, napi_get_array_length)(env, value, result);
}

napi_status NAPI_CDECL napi_get_cb_info(napi_env env, napi_callback_info cbinfo, size_t *argc, napi_value *argv,
                                        napi_value *this_arg, void **data) {
  return HOST_FUNCTION(HOST_GET_CB_INFO, napi_get_cb_info)(env, cbinfo, argc, argv, this_arg, data);
}

napi_status NAPI_CDECL napi_get_element(napi_env env, napi_value object, uint32_t index, napi_value *result) {
  return HOST_FUNCTION(HOST_GET_ELEMENT, napi_get_element)(env, object, index, result);
}

napi_status NAPI_CDECL napi_get_instance_data(node_api_basic_env env, void **data) {
  return HOST_FUNCTION(HOST_GET_INSTANCE_DATA, napi_get_instance_data)(env, data);
}

napi_status NAPI_CDECL napi_get_named_property(napi_env env, napi_value object, const char *utf8name,
                                               napi_value *result) {
  return HOST_FUNCTION(HOST_GET_NAMED_PROPERTY, napi_get_named_property)(env, object, utf8name, result);
}

napi_status NAPI_CDECL napi_get_typedarray_info(napi_env env, napi_value typedarray, napi_typedarray_type *type,
                                                size_t *length, void **data, napi_value *arraybuffer,
                                                size_t *byte_offset) {
  return HOST_FUNCTION(HOST_GET_TYPEDARRAY_INFO, napi_get_typedarray_info)(env, typedarray, type, length, data,
                                                                           arraybuffer, byte_offset);
}

napi_status NAPI_CDECL napi_get_value_external(napi_env env, napi_value value, void **result) {
  return HOST_FUNCTION(HOST_GET_VALUE_EXTERNAL, napi_get_value_external)(env, value, result);
}

napi_status NAPI_CDECL napi_get_value_int32(napi_env env, napi_value value, int32_t *result) {
  return HOST_FUNCTION(HOST_GET_VALUE_INT32, napi_get_value_int32)(env, value, result);
}

napi_status NAPI_CDECL napi_get_value_uint32(napi_env env, napi_value value, uint32_t *result) {
  return HOST_FUNCTION(HOST_GET_VALUE_UINT32, napi_get_value_uint32)(env, value, result);
}

napi_status NAPI_CDECL napi_is_typedarray(napi_env env, napi_value value, bool *result) {
  return HOST_FUNCTION(HOST_IS_TYPEDARRAY, napi_is_typedarray)(env, value, result);
}

napi_status NAPI_CDECL napi_set_instance_data(node_api_basic_env env, void *data, napi_finalize finalize_cb,
                                              void *finalize_hint) {
  return HOST_FUNCTION(HOST_SET_INSTANCE_DATA, napi_set_instance_data)(env, data, finalize_cb, finalize_hint);
}

napi_status NAPI_CDECL napi_throw_error(napi_env env, const char *code, const char *msg) {
  return HOST_FUNCTION(HOST_THROW_ERROR, napi_throw_error)(env, code, msg);
}

napi_status NAPI_CDECL napi_typeof(napi_env env, napi_value value, napi_valuetype *result) {
  return HOST_FUNCTION(HOST_TYPEOF, napi_typeof)(env, value, result);
}

#else

int host_api_ready(void) { return 1; }

#endif
