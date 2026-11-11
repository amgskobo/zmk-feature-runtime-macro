/* SPDX-License-Identifier: MIT
 * The runtime macro Studio RPC handler with the real nanopb codec: the lock
 * policy, the lifecycle error messages, and the step editor's byte-stream
 * rewrites. The macro store, custom settings and the Studio lock are
 * controlled; every store mutation is counted.
 */
#include <assert.h>
#include <errno.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pb_decode.h>
#include <pb_encode.h>

#ifdef NDEBUG
#error "Runtime macro RPC handler tests require assertions enabled"
#endif

#define LOG_MODULE_REGISTER(...)
#define LOG_WRN(...) ((void)0)
#define ARG_UNUSED(x) (void)(x)
#define MIN(a, b) ((a) < (b) ? (a) : (b))
#define ARRAY_SIZE(a) (sizeof(a) / sizeof((a)[0]))
#define BUILD_ASSERT(condition, message) _Static_assert(condition, message)
#define DT_NODELABEL(label) label
#define DEVICE_DT_NAME(node) #node
#define ZMK_STUDIO_RPC_HANDLER_UNSECURED 0
#define ZMK_RPC_CUSTOM_SUBSYSTEM_UI_URLS(...) .unused = 0
#define ZMK_RPC_CUSTOM_SUBSYSTEM(...)
#define ZMK_RPC_CUSTOM_SUBSYSTEM_RESPONSE_BUFFER(...)
#define ZMK_RPC_CUSTOM_SUBSYSTEM_RESPONSE_BUFFER_ALLOCATE(name, callback)                          \
    allocate_response(callback)

struct zmk_rpc_custom_subsystem_meta {
    int unused, security;
};
typedef struct {
    struct {
        size_t size;
        uint8_t bytes[512];
    } payload;
} zmk_custom_CallRequest;

enum zmk_studio_core_lock_state {
    ZMK_STUDIO_CORE_LOCK_STATE_LOCKED = 0,
    ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED = 1,
};
static enum zmk_studio_core_lock_state lock_state;
static enum zmk_studio_core_lock_state zmk_studio_core_get_lock_state(void) { return lock_state; }

enum zmk_custom_setting_write_mode {
    ZMK_CUSTOM_SETTING_WRITE_MODE_MEMORY,
    ZMK_CUSTOM_SETTING_WRITE_MODE_PERSIST,
};
struct zmk_custom_setting_value {
    int32_t int32_value;
};
#define ZMK_CUSTOM_SETTING_VALUE_INT32(v) ((struct zmk_custom_setting_value){.int32_value = (v)})

static unsigned mutations;
enum list_mode { LIST_ORIGINAL, LIST_MAXIMUM, LIST_HOLES, LIST_EMPTY, LIST_ERROR };
static enum list_mode list_mode;
static bool list_corrupted;
static unsigned list_reads;
static bool have_default;
static enum zmk_custom_setting_write_mode last_body_write_mode;
static int suppress_depth;
static uint32_t tap_ms = 30;
static void zmk_custom_settings_notify_suppress_begin(void) { suppress_depth++; }
static void zmk_custom_settings_notify_suppress_end(void) { suppress_depth--; }
static int zmk_custom_setting_write_by_key(const char *subsystem, const char *key,
                                           const struct zmk_custom_setting_value *value,
                                           enum zmk_custom_setting_write_mode mode) {
    (void)subsystem, (void)key, (void)mode;
    mutations++;
    tap_ms = value->int32_value;
    return 0;
}
static int zmk_custom_settings_save_scope(const char *subsystem, const char *key,
                                          const char *prefix, uint32_t *affected) {
    (void)subsystem, (void)key, (void)prefix;
    mutations++;
    *affected = 0;
    return 0;
}
static int zmk_custom_settings_discard_scope(const char *subsystem, const char *key,
                                             const char *prefix, uint32_t *affected) {
    (void)subsystem, (void)key, (void)prefix;
    mutations++;
    *affected = 0;
    return 0;
}
static uint16_t zmk_behavior_get_local_id(const char *name) {
    (void)name;
    return 7;
}

#include <cormoran/runtime_macro/runtime_macro.pb.h>

static cormoran_runtime_macro_Response response;
static cormoran_runtime_macro_Response *allocate_response(pb_callback_t *callback) {
    memset(&response, 0, sizeof(response));
    memset(callback, 0, sizeof(*callback));
    return &response;
}

struct zmk_behavior_binding_event;
#include <cormoran/zmk/runtime_macro.h>

/* Controlled store: a slot holds a name and its raw encoded body. */
static struct {
    bool in_use;
    char name[CONFIG_ZMK_RUNTIME_MACRO_NAME_MAX_LEN + 1];
    uint8_t body[CONFIG_ZMK_RUNTIME_MACRO_MAX_BYTES];
    size_t size;
} store[CONFIG_ZMK_RUNTIME_MACRO_COUNT];

static int find(const char *name) {
    for (int i = 0; i < CONFIG_ZMK_RUNTIME_MACRO_COUNT; i++) {
        if (store[i].in_use && strcmp(store[i].name, name) == 0) {
            return i;
        }
    }
    return -ENOENT;
}
int zmk_runtime_macro_unpack_key_tap(uint8_t packed_key, uint32_t *keycode) {
    uint8_t usage = packed_key & 0x7f;
    if (usage < 0x04 || usage > 0x38) {
        return -EINVAL;
    }
    *keycode = usage;
    return 0;
}
uint32_t zmk_runtime_macro_tap_ms(void) { return tap_ms; }
int zmk_runtime_macro_create(const char *name, const uint8_t *encoded, size_t size,
                             enum zmk_custom_setting_write_mode mode, uint32_t *out_slot) {
    (void)mode;
    if (strlen(name) > CONFIG_ZMK_RUNTIME_MACRO_NAME_MAX_LEN) {
        return -ENAMETOOLONG;
    }
    if (find(name) >= 0) {
        return -EEXIST;
    }
    for (uint32_t i = 0; i < CONFIG_ZMK_RUNTIME_MACRO_COUNT; i++) {
        if (!store[i].in_use) {
            mutations++;
            store[i].in_use = true;
            snprintf(store[i].name, sizeof(store[i].name), "%s", name);
            memcpy(store[i].body, encoded, size);
            store[i].size = size;
            *out_slot = i;
            return 0;
        }
    }
    return -ENOSPC;
}
int zmk_runtime_macro_delete(const char *name) {
    int slot = find(name);
    if (slot < 0) {
        return slot;
    }
    mutations++;
    store[slot].in_use = false;
    return 0;
}
int zmk_runtime_macro_write(const char *name, const uint8_t *encoded, size_t size,
                            enum zmk_custom_setting_write_mode mode) {
    last_body_write_mode = mode;
    int slot = find(name);
    if (slot < 0) {
        return slot;
    }
    mutations++;
    memcpy(store[slot].body, encoded, size);
    store[slot].size = size;
    return 0;
}
int zmk_runtime_macro_read(const char *name, uint8_t *encoded, size_t capacity, size_t *size) {
    int slot = find(name);
    if (slot < 0) {
        return slot;
    }
    assert(store[slot].size <= capacity);
    memcpy(encoded, store[slot].body, store[slot].size);
    *size = store[slot].size;
    return 0;
}
int zmk_runtime_macro_rename(const char *old_name, const char *new_name,
                             enum zmk_custom_setting_write_mode mode) {
    (void)mode;
    int slot = find(old_name);
    if (slot < 0) {
        return slot;
    }
    if (find(new_name) >= 0) {
        return -EEXIST;
    }
    mutations++;
    snprintf(store[slot].name, sizeof(store[slot].name), "%s", new_name);
    return 0;
}
int zmk_runtime_macro_default_encode(const char *name, uint8_t *encoded, size_t capacity,
                                     size_t *size) {
    (void)name;
    if (have_default) {
        const uint8_t body[] = {1, ZMK_RUNTIME_MACRO_OP_DELAY, 9};
        assert(capacity >= sizeof(body));
        memcpy(encoded, body, sizeof(body));
        *size = sizeof(body);
        return 0;
    }
    return -ENOENT;
}
int zmk_runtime_macro_name_for_slot(uint32_t slot, char *name, size_t capacity) {
    if (slot >= CONFIG_ZMK_RUNTIME_MACRO_COUNT) {
        return -ERANGE;
    }
    if (!store[slot].in_use) {
        return -ENOENT;
    }
    snprintf(name, capacity, "%s", store[slot].name);
    return 0;
}
size_t zmk_runtime_macro_pool_total(void) { return 1024; }
size_t zmk_runtime_macro_pool_used(void) { return 0; }
int zmk_runtime_macro_for_each(zmk_runtime_macro_iter_cb_t cb, void *user_data) {
    if (list_mode != LIST_ORIGINAL) {
        list_reads++;
        if (list_corrupted) {
            return -EIO;
        }
        for (uint32_t slot = 0; slot < CONFIG_ZMK_RUNTIME_MACRO_COUNT; slot++) {
            if (list_mode == LIST_EMPTY || (list_mode == LIST_HOLES && (slot == 1 || slot == 3))) {
                continue;
            }
            if (list_mode == LIST_ERROR && slot == 2) {
                return -EIO;
            }
            char name[CONFIG_ZMK_RUNTIME_MACRO_NAME_MAX_LEN + 1];
            for (size_t i = 0; i < sizeof(name) - 1; i++) {
                name[i] = 'A' + (slot + i) % 26;
            }
            name[sizeof(name) - 1] = '\0';
            int ret = cb(slot, name, slot == 2 ? 0 : UINT32_MAX - slot, slot % 2, user_data);
            if (ret < 0) {
                return ret;
            }
        }
        return 0;
    }
    for (uint32_t i = 0; i < CONFIG_ZMK_RUNTIME_MACRO_COUNT; i++) {
        if (store[i].in_use) {
            int ret = cb(i, store[i].name, store[i].size, false, user_data);
            if (ret < 0) {
                return ret;
            }
        }
    }
    return 0;
}

#include HANDLER_SOURCE

static void call(const cormoran_runtime_macro_Request *req) {
    zmk_custom_CallRequest raw = {0};
    pb_ostream_t out = pb_ostream_from_buffer(raw.payload.bytes, sizeof(raw.payload.bytes));
    assert(pb_encode(&out, cormoran_runtime_macro_Request_fields, req));
    raw.payload.size = out.bytes_written;
    pb_callback_t callback = {0};
    assert(runtime_macro_rpc_handle_request(&raw, &callback));
    assert(suppress_depth == 0);
}
static cormoran_runtime_macro_Request request(pb_size_t tag) {
    cormoran_runtime_macro_Request req = cormoran_runtime_macro_Request_init_zero;
    req.which_request_type = tag;
    return req;
}
static void expect_error(const char *message) {
    assert(response.which_response_type == cormoran_runtime_macro_Response_error_tag);
    if (strcmp(response.response_type.error.message, message) != 0) {
        fprintf(stderr, "error \"%s\", expected \"%s\"\n", response.response_type.error.message,
                message);
        assert(0);
    }
}
static void expect_status(void) {
    if (response.which_response_type != cormoran_runtime_macro_Response_status_tag) {
        fprintf(stderr, "error \"%s\"\n", response.response_type.error.message);
        assert(0);
    }
}
static void expect_body(const uint8_t *body, size_t size) {
    assert(store[0].in_use && store[0].size == size && memcmp(store[0].body, body, size) == 0);
}
static void create(const char *name) {
    cormoran_runtime_macro_Request req = request(cormoran_runtime_macro_Request_create_macro_tag);
    snprintf(req.request_type.create_macro.name, sizeof(req.request_type.create_macro.name), "%s",
             name);
    call(&req);
}
static void append(cormoran_runtime_macro_MacroStep step) {
    cormoran_runtime_macro_Request req =
        request(cormoran_runtime_macro_Request_append_macro_step_tag);
    req.request_type.append_macro_step.has_step = true;
    req.request_type.append_macro_step.step = step;
    call(&req);
    expect_status();
}
static cormoran_runtime_macro_MacroStep delay(uint32_t ms) {
    cormoran_runtime_macro_MacroStep step = cormoran_runtime_macro_MacroStep_init_zero;
    step.which_step = cormoran_runtime_macro_MacroStep_delay_tag;
    step.step.delay.delay_ms = ms;
    return step;
}

/* GetMacro streams the stored steps; it must encode the same bytes as a reply
 * built from the expected step list. */
static const cormoran_runtime_macro_MacroStep *expected_steps;
static size_t expected_count;
static bool encode_expected(pb_ostream_t *stream, const pb_field_t *field, void *const *arg) {
    (void)arg;
    for (size_t i = 0; i < expected_count; i++) {
        if (!pb_encode_tag_for_field(stream, field) ||
            !pb_encode_submessage(stream, cormoran_runtime_macro_MacroStep_fields,
                                  &expected_steps[i])) {
            return false;
        }
    }
    return true;
}
static bool encode_reply(uint8_t *buf, size_t capacity, size_t *size) {
    pb_ostream_t out = pb_ostream_from_buffer(buf, capacity);
    bool ok = pb_encode(&out, cormoran_runtime_macro_Response_fields, &response);
    *size = out.bytes_written;
    return ok;
}
static void expect_steps(const cormoran_runtime_macro_MacroStep *steps, size_t count) {
    cormoran_runtime_macro_Request req = request(cormoran_runtime_macro_Request_get_macro_tag);
    call(&req);
    assert(response.which_response_type == cormoran_runtime_macro_Response_get_macro_tag);
    static uint8_t actual[2048], expected[2048];
    size_t actual_size, expected_size;
    assert(encode_reply(actual, sizeof(actual), &actual_size));
    expected_steps = steps;
    expected_count = count;
    response.response_type.get_macro.macro.steps.funcs.encode = encode_expected;
    assert(encode_reply(expected, sizeof(expected), &expected_size));
    assert(actual_size == expected_size && memcmp(actual, expected, actual_size) == 0);
}

static void list_wire_vector(enum list_mode mode, const char *name) {
    list_mode = mode;
    list_corrupted = false;
    list_reads = 0;
    lock_state = ZMK_STUDIO_CORE_LOCK_STATE_LOCKED;
    cormoran_runtime_macro_Request req = request(cormoran_runtime_macro_Request_list_macros_tag);
    const unsigned before = mutations;
    call(&req);
    assert(mutations == before && list_reads == 1);
    if (mode == LIST_ERROR) {
        expect_error("Runtime macro RPC failed: -5");
    } else {
        assert(response.which_response_type == cormoran_runtime_macro_Response_list_macros_tag);
    }
    size_t expected_size;
    assert(pb_get_encoded_size(&expected_size, cormoran_runtime_macro_Response_fields, &response));
    list_corrupted = true;
    static uint8_t encoded[4096];
    pb_ostream_t stream = pb_ostream_from_buffer(encoded, sizeof(encoded));
    assert(pb_encode(&stream, cormoran_runtime_macro_Response_fields, &response));
    assert(stream.bytes_written == expected_size);
    size_t repeated_size;
    assert(pb_get_encoded_size(&repeated_size, cormoran_runtime_macro_Response_fields, &response));
    assert(repeated_size == expected_size && list_reads == 1);
    printf("WIRE %s ", name);
    for (size_t i = 0; i < stream.bytes_written; i++) {
        printf("%02x", encoded[i]);
    }
    printf("\n");
    list_mode = LIST_ORIGINAL;
    list_corrupted = false;
}

static void list_wire_vectors(void) {
    list_wire_vector(LIST_MAXIMUM, "maximum");
    list_wire_vector(LIST_HOLES, "holes");
    list_wire_vector(LIST_EMPTY, "empty");
    list_wire_vector(LIST_ERROR, "iterator_error");
    printf("runtime macro list wire: PASS count=%d name=%d bytes=%d\n",
           CONFIG_ZMK_RUNTIME_MACRO_COUNT, CONFIG_ZMK_RUNTIME_MACRO_NAME_MAX_LEN,
           CONFIG_ZMK_RUNTIME_MACRO_MAX_BYTES);
    printf("runtime macro response bytes: %zu\n", sizeof(response));
    printf("runtime macro response alignment: %zu\n", _Alignof(cormoran_runtime_macro_Response));
}

int main(void) {
    if (getenv("MACRO_RPC_LIST_ONLY")) {
        list_wire_vectors();
        return 0;
    }
    const pb_size_t locked_out[] = {
        cormoran_runtime_macro_Request_get_macro_tag,
        cormoran_runtime_macro_Request_set_macro_step_count_tag,
        cormoran_runtime_macro_Request_set_tap_ms_tag,
        cormoran_runtime_macro_Request_set_macro_step_tag,
        cormoran_runtime_macro_Request_append_macro_step_tag,
        cormoran_runtime_macro_Request_create_macro_tag,
        cormoran_runtime_macro_Request_delete_macro_tag,
        cormoran_runtime_macro_Request_rename_macro_tag,
        cormoran_runtime_macro_Request_reset_macro_tag,
        cormoran_runtime_macro_Request_save_macros_tag,
        cormoran_runtime_macro_Request_discard_macros_tag,
    };

    /* Locked: contents and every change are refused before reaching the store;
     * the two metadata reads still answer. */
    store[0].in_use = true;
    snprintf(store[0].name, sizeof(store[0].name), "Seeded");
    lock_state = ZMK_STUDIO_CORE_LOCK_STATE_LOCKED;
    for (size_t i = 0; i < ARRAY_SIZE(locked_out); i++) {
        cormoran_runtime_macro_Request req = request(locked_out[i]);
        call(&req);
        expect_error("Studio must be unlocked to read or edit macro contents");
    }
    assert(mutations == 0);
    cormoran_runtime_macro_Request req = request(cormoran_runtime_macro_Request_list_macros_tag);
    call(&req);
    assert(response.which_response_type == cormoran_runtime_macro_Response_list_macros_tag);
    assert(response.response_type.list_macros.macros_count == 1);
    req = request(cormoran_runtime_macro_Request_get_macro_global_settings_tag);
    call(&req);
    assert(response.response_type.get_macro_global_settings.settings.tap_ms == 30);
    assert(response.response_type.get_macro_global_settings.settings.key_press_behavior_id == 7);
    assert(mutations == 0);
    store[0].in_use = false;
    printf("runtime macro rpc lock: PASS refused=%zu\n", ARRAY_SIZE(locked_out));

    /* Unlocked lifecycle errors map to their own messages. */
    lock_state = ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED;
    create("Greeting");
    expect_status();
    create("Greeting");
    expect_error("A macro with that name already exists");
    char long_name[CONFIG_ZMK_RUNTIME_MACRO_NAME_MAX_LEN + 2];
    memset(long_name, 'n', sizeof(long_name) - 1);
    long_name[sizeof(long_name) - 1] = '\0';
    create(long_name);
    expect_error("Macro name is too long");
    req = request(cormoran_runtime_macro_Request_rename_macro_tag);
    snprintf(req.request_type.rename_macro.old_name, sizeof(req.request_type.rename_macro.old_name),
             "Missing");
    snprintf(req.request_type.rename_macro.new_name, sizeof(req.request_type.rename_macro.new_name),
             "Other");
    call(&req);
    expect_error("No macro with that name");

    /* The step editor rewrites the stored byte stream exactly. */
    cormoran_runtime_macro_MacroStep tap = cormoran_runtime_macro_MacroStep_init_zero;
    tap.which_step = cormoran_runtime_macro_MacroStep_tap_tag;
    tap.step.tap = (cormoran_runtime_macro_BehaviorBinding){.behavior_id = 7, .param1 = 300};
    cormoran_runtime_macro_MacroStep keys = cormoran_runtime_macro_MacroStep_init_zero;
    keys.which_step = cormoran_runtime_macro_MacroStep_key_tap_sequence_tag;
    keys.step.key_tap_sequence.packed_keys.size = 2;
    keys.step.key_tap_sequence.packed_keys.bytes[0] = 0x04;
    keys.step.key_tap_sequence.packed_keys.bytes[1] = 0x85;
    append(delay(5));
    append(tap);
    append(keys);
    const uint8_t appended[] = {1,
                                ZMK_RUNTIME_MACRO_OP_DELAY,
                                5,
                                ZMK_RUNTIME_MACRO_OP_TAP,
                                7,
                                0xac,
                                0x02,
                                0,
                                ZMK_RUNTIME_MACRO_OP_KEY_TAP_SEQUENCE,
                                2,
                                0x04,
                                0x85};
    expect_body(appended, sizeof(appended));
    expect_steps((cormoran_runtime_macro_MacroStep[]){delay(5), tap, keys}, 3);

    req = request(cormoran_runtime_macro_Request_set_macro_step_tag);
    req.request_type.set_macro_step.step_index = 2;
    req.request_type.set_macro_step.has_step = true;
    req.request_type.set_macro_step.step = delay(200);
    call(&req);
    expect_status();
    const uint8_t replaced[] = {1,
                                ZMK_RUNTIME_MACRO_OP_DELAY,
                                5,
                                ZMK_RUNTIME_MACRO_OP_TAP,
                                7,
                                0xac,
                                0x02,
                                0,
                                ZMK_RUNTIME_MACRO_OP_DELAY,
                                0xc8,
                                0x01};
    expect_body(replaced, sizeof(replaced));
    req.request_type.set_macro_step.step_index = 3;
    call(&req);
    expect_error("Runtime macro RPC failed: -34");

    req = request(cormoran_runtime_macro_Request_set_macro_step_count_tag);
    req.request_type.set_macro_step_count.step_count = 1;
    call(&req);
    expect_status();
    req.request_type.set_macro_step_count.step_count = 3;
    call(&req);
    expect_status();
    const uint8_t resized[] = {1, ZMK_RUNTIME_MACRO_OP_DELAY, 5, ZMK_RUNTIME_MACRO_OP_DELAY,
                               0, ZMK_RUNTIME_MACRO_OP_DELAY, 0};
    expect_body(resized, sizeof(resized));
    expect_steps((cormoran_runtime_macro_MacroStep[]){delay(5), delay(0), delay(0)}, 3);

    /* A delay that would hold ZMK's shared behavior queue is refused before
     * the store, by append and by replace alike. */
    unsigned before = mutations;
    req = request(cormoran_runtime_macro_Request_append_macro_step_tag);
    req.request_type.append_macro_step.has_step = true;
    req.request_type.append_macro_step.step = delay(ZMK_RUNTIME_MACRO_DELAY_MS_MAX + 1);
    call(&req);
    expect_error("Delay must be at most 60000 ms");
    req = request(cormoran_runtime_macro_Request_set_macro_step_tag);
    req.request_type.set_macro_step.has_step = true;
    req.request_type.set_macro_step.step = delay(ZMK_RUNTIME_MACRO_DELAY_MS_MAX + 1);
    call(&req);
    expect_error("Delay must be at most 60000 ms");
    assert(mutations == before);
    expect_body(resized, sizeof(resized));
    printf("runtime macro rpc step editor: PASS\n");

    /* A stored body with a five-byte varint that overflows 32 bits is refused
     * by GetMacro, as by playback, instead of being shown truncated. */
    const uint8_t overflow[] = {1, ZMK_RUNTIME_MACRO_OP_DELAY, 0xff, 0xff, 0xff, 0xff, 0x1f};
    memcpy(store[0].body, overflow, sizeof(overflow));
    store[0].size = sizeof(overflow);
    req = request(cormoran_runtime_macro_Request_get_macro_tag);
    call(&req);
    uint8_t reply[512];
    size_t reply_size;
    expect_error("Stored macro body is malformed");
    assert(encode_reply(reply, sizeof(reply), &reply_size));
    assert(reply_size > 0);
    printf("runtime macro rpc varint: PASS overflow refused\n");

    const uint8_t malformed[][5] = {
        {1, 0xff},
        {2},
        {1, ZMK_RUNTIME_MACRO_OP_DELAY, 0x80},
        {1, ZMK_RUNTIME_MACRO_OP_TAP, 1},
        {1, ZMK_RUNTIME_MACRO_OP_KEY_TAP_SEQUENCE, 2, 0x04},
        {1, ZMK_RUNTIME_MACRO_OP_KEY_TAP_SEQUENCE, 1, 0},
    };
    const size_t malformed_sizes[] = {2, 1, 3, 3, 4, 4};
    for (size_t i = 0; i < ARRAY_SIZE(malformed); i++) {
        memcpy(store[0].body, malformed[i], malformed_sizes[i]);
        store[0].size = malformed_sizes[i];
        call(&req);
        expect_error("Stored macro body is malformed");
        assert(encode_reply(reply, sizeof(reply), &reply_size) && reply_size > 0);
        assert(store[0].size == malformed_sizes[i] &&
               !memcmp(store[0].body, malformed[i], malformed_sizes[i]));
    }
    memcpy(store[0].body, resized, sizeof(resized));
    store[0].size = sizeof(resized);
    call(&req);
    assert(response.which_response_type == cormoran_runtime_macro_Response_get_macro_tag);
    lock_state = ZMK_STUDIO_CORE_LOCK_STATE_LOCKED;
    assert(!encode_reply(reply, sizeof(reply), &reply_size));
    lock_state = ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED;
    assert(encode_reply(reply, sizeof(reply), &reply_size));
    printf("runtime macro rpc stored bodies: PASS valid errors, unchanged data and late-lock "
           "refusal\n");

    req = request(cormoran_runtime_macro_Request_set_tap_ms_tag);
    req.request_type.set_tap_ms.tap_ms = ZMK_RUNTIME_MACRO_TAP_MS_MAX + 1;
    call(&req);
    expect_error("Runtime macro RPC failed: -34");
    req.request_type.set_tap_ms.tap_ms = 50;
    call(&req);
    expect_status();
    assert(tap_ms == 50);

    /* A nonpersistent reset cannot reach the durable-delete API. A default
     * still resets in memory, and explicit persistent reset may delete. */
    const uint8_t reset_body[] = {1, ZMK_RUNTIME_MACRO_OP_DELAY, 7};
    memcpy(store[0].body, reset_body, sizeof(reset_body));
    store[0].size = sizeof(reset_body);
    before = mutations;
    req = request(cormoran_runtime_macro_Request_reset_macro_tag);
    req.request_type.reset_macro.persist = false;
    call(&req);
    expect_error("No devicetree default: use Delete to remove this macro");
    assert(mutations == before && store[0].in_use);
    expect_body(reset_body, sizeof(reset_body));
    have_default = true;
    call(&req);
    expect_status();
    const uint8_t default_body[] = {1, ZMK_RUNTIME_MACRO_OP_DELAY, 9};
    expect_body(default_body, sizeof(default_body));
    assert(last_body_write_mode == ZMK_CUSTOM_SETTING_WRITE_MODE_MEMORY);
    have_default = false;
    req.request_type.reset_macro.persist = true;
    call(&req);
    expect_status();
    assert(!store[0].in_use);
    printf("runtime macro rpc reset: PASS memory refusal, default and explicit deletion\n");
    store[0].in_use = true;

    req = request(cormoran_runtime_macro_Request_delete_macro_tag);
    snprintf(req.request_type.delete_macro.name, sizeof(req.request_type.delete_macro.name),
             "Greeting");
    call(&req);
    expect_status();
    req = request(cormoran_runtime_macro_Request_get_macro_tag);
    call(&req);
    expect_error(NO_MACRO_IN_SLOT);
    (void)runtime_macro_meta;
    list_wire_vectors();
    printf("runtime macro rpc handler: PASS variant=%s\n", TEST_VARIANT);
    return 0;
}
