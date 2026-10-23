/*
 * Copyright (c) 2026 cormoran
 *
 * SPDX-License-Identifier: MIT
 */

#include <errno.h>
#include <stdio.h>
#include <string.h>

#include <pb_decode.h>
#include <pb_encode.h>
#include <zephyr/device.h>
#include <zephyr/sys/util.h>
#include <zmk/studio/core.h>
#include <zmk/studio/custom.h>
#include <cormoran/runtime_macro/runtime_macro.pb.h>
#include <cormoran/zmk/custom_settings.h>
#include <cormoran/zmk/runtime_macro.h>

#include "../runtime_macro_codec.h"

#include <zephyr/logging/log.h>
#ifndef CONFIG_ZMK_RUNTIME_MACRO_FORK_LOG_LEVEL
#define CONFIG_ZMK_RUNTIME_MACRO_FORK_LOG_LEVEL 3
#endif
LOG_MODULE_REGISTER(zmk_runtime_macro_fork_runtime_macro_handler,
                    CONFIG_ZMK_RUNTIME_MACRO_FORK_LOG_LEVEL);

#define RUNTIME_MACRO_RPC_MAX_STEPS 64

static bool runtime_macro_rpc_handle_request(const zmk_custom_CallRequest *raw_request,
                                             pb_callback_t *encode_response);

/* The subsystem is registered UNSECURED so that ListMacros (and the equally
 * content-free GetMacroGlobalSettings) can be answered while Studio is locked -
 * they only expose per-macro metadata (slot/name/size/unsaved) and global
 * limits, never a macro's actual steps. The framework's security gate is
 * all-or-nothing per subsystem, so the finer "unlock only to read contents or
 * to write" rule is enforced per-request in the handler via
 * request_requires_unlock(). */
static struct zmk_rpc_custom_subsystem_meta runtime_macro_meta = {
    ZMK_RPC_CUSTOM_SUBSYSTEM_UI_URLS("https://cormoran.github.io/zmk-feature-runtime-macro/"),
    .security = ZMK_STUDIO_RPC_HANDLER_UNSECURED,
};

ZMK_RPC_CUSTOM_SUBSYSTEM(cormoran__runtime_macro, &runtime_macro_meta,
                         runtime_macro_rpc_handle_request);

ZMK_RPC_CUSTOM_SUBSYSTEM_RESPONSE_BUFFER(cormoran__runtime_macro, cormoran_runtime_macro_Response);

/* Every slot fits one ListMacros reply, every name fits the name fields, and
 * one KEY_TAP_SEQUENCE opcode maps to exactly one KeyTapSequenceStep. */
BUILD_ASSERT(CONFIG_ZMK_RUNTIME_MACRO_COUNT <=
                 ARRAY_SIZE(((cormoran_runtime_macro_ListMacrosResponse *)NULL)->macros),
             "CONFIG_ZMK_RUNTIME_MACRO_COUNT exceeds the ListMacrosResponse capacity");
BUILD_ASSERT(CONFIG_ZMK_RUNTIME_MACRO_NAME_MAX_LEN <
                     sizeof(((cormoran_runtime_macro_MacroSummary *)NULL)->name) &&
                 CONFIG_ZMK_RUNTIME_MACRO_NAME_MAX_LEN <
                     sizeof(((cormoran_runtime_macro_CreateMacroRequest *)NULL)->name),
             "CONFIG_ZMK_RUNTIME_MACRO_NAME_MAX_LEN exceeds the RPC name capacity");
BUILD_ASSERT(ZMK_RUNTIME_MACRO_KEY_TAP_SEQUENCE_MAX_KEYS ==
                 sizeof(((cormoran_runtime_macro_KeyTapSequenceStep *)NULL)->packed_keys.bytes),
             "ZMK_RUNTIME_MACRO_KEY_TAP_SEQUENCE_MAX_KEYS must match KeyTapSequenceStep");

#define NO_MACRO_IN_SLOT "No macro in that slot: create one, then read its slot from the macro list"
BUILD_ASSERT(sizeof(NO_MACRO_IN_SLOT) <=
                 sizeof(((cormoran_runtime_macro_ErrorResponse *)NULL)->message),
             "NO_MACRO_IN_SLOT does not fit ErrorResponse.message");

static void set_error(cormoran_runtime_macro_Response *resp, const char *message) {
    cormoran_runtime_macro_ErrorResponse err = cormoran_runtime_macro_ErrorResponse_init_zero;

    snprintf(err.message, sizeof(err.message), "%s", message);
    resp->which_response_type = cormoran_runtime_macro_Response_error_tag;
    resp->response_type.error = err;
}

static void set_status(cormoran_runtime_macro_Response *resp, uint32_t affected_count,
                       const char *message) {
    cormoran_runtime_macro_StatusResponse result = cormoran_runtime_macro_StatusResponse_init_zero;
    result.affected_count = affected_count;
    snprintf(result.message, sizeof(result.message), "%s", message);
    resp->which_response_type = cormoran_runtime_macro_Response_status_tag;
    resp->response_type.status = result;
}

static enum zmk_custom_setting_write_mode write_mode(bool persist) {
    return persist ? ZMK_CUSTOM_SETTING_WRITE_MODE_PERSIST : ZMK_CUSTOM_SETTING_WRITE_MODE_MEMORY;
}

static int read_step_binding(const uint8_t *encoded, size_t size, size_t *offset,
                             cormoran_runtime_macro_BehaviorBinding *binding) {
    int ret = runtime_macro_read_uvar(encoded, size, offset, &binding->behavior_id);
    if (ret < 0) {
        return ret;
    }
    ret = runtime_macro_read_uvar(encoded, size, offset, &binding->param1);
    if (ret < 0) {
        return ret;
    }
    return runtime_macro_read_uvar(encoded, size, offset, &binding->param2);
}

static int append_step_binding(uint8_t *dest, size_t capacity, size_t *offset,
                               const cormoran_runtime_macro_BehaviorBinding *binding) {
    int ret = runtime_macro_append_uvar(dest, capacity, offset, binding->behavior_id);
    if (ret < 0) {
        return ret;
    }
    ret = runtime_macro_append_uvar(dest, capacity, offset, binding->param1);
    if (ret < 0) {
        return ret;
    }
    return runtime_macro_append_uvar(dest, capacity, offset, binding->param2);
}

static int read_key_tap_sequence_step(const uint8_t *encoded, size_t size, size_t *offset,
                                      cormoran_runtime_macro_KeyTapSequenceStep *sequence) {
    uint32_t sequence_size;
    int ret = runtime_macro_read_uvar(encoded, size, offset, &sequence_size);
    if (ret < 0) {
        return ret;
    }
    if (sequence_size > size - *offset || sequence_size > sizeof(sequence->packed_keys.bytes)) {
        return -EINVAL;
    }

    for (uint32_t i = 0; i < sequence_size; i++) {
        uint32_t keycode;
        ret = zmk_runtime_macro_unpack_key_tap(encoded[*offset + i], &keycode);
        if (ret < 0) {
            return ret;
        }
    }

    sequence->packed_keys.size = sequence_size;
    memcpy(sequence->packed_keys.bytes, &encoded[*offset], sequence_size);
    *offset += sequence_size;
    return 0;
}

static int append_key_tap_sequence_step(uint8_t *dest, size_t capacity, size_t *offset,
                                        const cormoran_runtime_macro_KeyTapSequenceStep *sequence) {
    int ret = runtime_macro_append_uvar(dest, capacity, offset, sequence->packed_keys.size);
    if (ret < 0) {
        return ret;
    }

    if (sequence->packed_keys.size > capacity - *offset) {
        return -ENOSPC;
    }

    for (size_t i = 0; i < sequence->packed_keys.size; i++) {
        uint32_t keycode;
        ret = zmk_runtime_macro_unpack_key_tap(sequence->packed_keys.bytes[i], &keycode);
        if (ret < 0) {
            return ret;
        }
        dest[(*offset)++] = sequence->packed_keys.bytes[i];
    }

    return 0;
}

/* Decode exactly one step from `encoded` starting at *offset (which must point
 * at an opcode byte, i.e. *offset < encoded_size), advancing *offset past it.
 * Lets callers walk the stored byte stream one step at a time without ever
 * materializing the whole steps[64] array. */
static int decode_one_step(const uint8_t *encoded, size_t encoded_size, size_t *offset,
                           cormoran_runtime_macro_MacroStep *step) {
    *step = (cormoran_runtime_macro_MacroStep)cormoran_runtime_macro_MacroStep_init_zero;

    uint8_t opcode = encoded[(*offset)++];
    switch (opcode) {
    case ZMK_RUNTIME_MACRO_OP_DOWN:
        step->which_step = cormoran_runtime_macro_MacroStep_down_tag;
        return read_step_binding(encoded, encoded_size, offset, &step->step.down);
    case ZMK_RUNTIME_MACRO_OP_UP:
        step->which_step = cormoran_runtime_macro_MacroStep_up_tag;
        return read_step_binding(encoded, encoded_size, offset, &step->step.up);
    case ZMK_RUNTIME_MACRO_OP_TAP:
        step->which_step = cormoran_runtime_macro_MacroStep_tap_tag;
        return read_step_binding(encoded, encoded_size, offset, &step->step.tap);
    case ZMK_RUNTIME_MACRO_OP_DELAY:
        step->which_step = cormoran_runtime_macro_MacroStep_delay_tag;
        return runtime_macro_read_uvar(encoded, encoded_size, offset, &step->step.delay.delay_ms);
    case ZMK_RUNTIME_MACRO_OP_KEY_TAP_SEQUENCE:
        step->which_step = cormoran_runtime_macro_MacroStep_key_tap_sequence_tag;
        return read_key_tap_sequence_step(encoded, encoded_size, offset,
                                          &step->step.key_tap_sequence);
    default:
        return -EINVAL;
    }
}

/* Count the steps in a stored macro blob without decoding them into an array. */
static int count_steps(const uint8_t *encoded, size_t encoded_size, pb_size_t *count) {
    *count = 0;

    if (encoded_size == 0) {
        return 0;
    }
    if (encoded[0] != ZMK_RUNTIME_MACRO_FORMAT_VERSION) {
        return -EINVAL;
    }

    size_t offset = 1;
    while (offset < encoded_size) {
        cormoran_runtime_macro_MacroStep step;
        int ret = decode_one_step(encoded, encoded_size, &offset, &step);
        if (ret < 0) {
            return ret;
        }
        (*count)++;
    }

    return 0;
}

/* Append exactly one step's opcode+args to `encoded` at *offset, advancing it.
 * The caller writes the leading ZMK_RUNTIME_MACRO_FORMAT_VERSION byte.
 *
 * No packed-key-run splitting is needed: KeyTapSequenceStep.packed_keys holds
 * ZMK_RUNTIME_MACRO_KEY_TAP_SEQUENCE_MAX_KEYS keys, so every MacroStep encodes
 * to at most one such opcode; the devicetree defaults split longer text the
 * same way. A macro carries more *steps* up to
 * CONFIG_ZMK_RUNTIME_MACRO_MAX_BYTES total, not longer sequences. */
static int encode_one_step(const cormoran_runtime_macro_MacroStep *step, uint8_t *encoded,
                           size_t encoded_capacity, size_t *offset) {
    const cormoran_runtime_macro_BehaviorBinding *binding = NULL;
    uint8_t opcode;

    switch (step->which_step) {
    case cormoran_runtime_macro_MacroStep_down_tag:
        opcode = ZMK_RUNTIME_MACRO_OP_DOWN;
        binding = &step->step.down;
        break;
    case cormoran_runtime_macro_MacroStep_up_tag:
        opcode = ZMK_RUNTIME_MACRO_OP_UP;
        binding = &step->step.up;
        break;
    case cormoran_runtime_macro_MacroStep_tap_tag:
        opcode = ZMK_RUNTIME_MACRO_OP_TAP;
        binding = &step->step.tap;
        break;
    case cormoran_runtime_macro_MacroStep_delay_tag:
        opcode = ZMK_RUNTIME_MACRO_OP_DELAY;
        break;
    case cormoran_runtime_macro_MacroStep_key_tap_sequence_tag:
        opcode = ZMK_RUNTIME_MACRO_OP_KEY_TAP_SEQUENCE;
        break;
    default:
        return -EINVAL;
    }

    if (*offset >= encoded_capacity) {
        return -ENOSPC;
    }
    encoded[(*offset)++] = opcode;

    if (opcode == ZMK_RUNTIME_MACRO_OP_DELAY) {
        return runtime_macro_append_uvar(encoded, encoded_capacity, offset,
                                         step->step.delay.delay_ms);
    }
    if (opcode == ZMK_RUNTIME_MACRO_OP_KEY_TAP_SEQUENCE) {
        return append_key_tap_sequence_step(encoded, encoded_capacity, offset,
                                            &step->step.key_tap_sequence);
    }
    return append_step_binding(encoded, encoded_capacity, offset, binding);
}

static int list_macros_cb(uint32_t slot, const char *name, size_t encoded_size,
                          bool has_unsaved_changes, void *user_data) {
    cormoran_runtime_macro_ListMacrosResponse *result = user_data;

    if (result->macros_count >= ARRAY_SIZE(result->macros)) {
        return -ENOSPC;
    }

    cormoran_runtime_macro_MacroSummary *summary = &result->macros[result->macros_count++];
    summary->slot = slot;
    snprintf(summary->name, sizeof(summary->name), "%s", name);
    summary->encoded_size = encoded_size;
    summary->has_unsaved_changes = has_unsaved_changes;

    return 0;
}

static int handle_list_macros(cormoran_runtime_macro_Response *resp) {
    /* Built in the (zeroed) response buffer itself: a second copy would put
     * the whole list on the RPC thread's stack. */
    cormoran_runtime_macro_ListMacrosResponse *result = &resp->response_type.list_macros;
    resp->which_response_type = cormoran_runtime_macro_Response_list_macros_tag;
    result->max_macro_bytes = CONFIG_ZMK_RUNTIME_MACRO_MAX_BYTES;
    result->max_name_length = CONFIG_ZMK_RUNTIME_MACRO_NAME_MAX_LEN;

    return zmk_runtime_macro_for_each(list_macros_cb, result);
}

/* A delay above ZMK_RUNTIME_MACRO_DELAY_MS_MAX would hold ZMK's shared
 * behavior queue; refuse it with its own message rather than a bare errno. */
static bool refuse_long_delay(const cormoran_runtime_macro_MacroStep *step,
                              cormoran_runtime_macro_Response *resp) {
    if (step->which_step != cormoran_runtime_macro_MacroStep_delay_tag ||
        step->step.delay.delay_ms <= ZMK_RUNTIME_MACRO_DELAY_MS_MAX) {
        return false;
    }
    char message[sizeof(resp->response_type.error.message)];
    snprintf(message, sizeof(message), "Delay must be at most %u ms",
             (unsigned int)ZMK_RUNTIME_MACRO_DELAY_MS_MAX);
    set_error(resp, message);
    return true;
}

static void handle_get_macro_global_settings(cormoran_runtime_macro_Response *resp) {
    cormoran_runtime_macro_GetMacroGlobalSettingsResponse result =
        cormoran_runtime_macro_GetMacroGlobalSettingsResponse_init_zero;

    result.has_settings = true;
    result.settings.tap_ms = zmk_runtime_macro_tap_ms();
    result.settings.max_entries = CONFIG_ZMK_RUNTIME_MACRO_COUNT;
    result.settings.key_press_behavior_id =
        zmk_behavior_get_local_id(DEVICE_DT_NAME(DT_NODELABEL(kp)));
    result.settings.pool_bytes_total = zmk_runtime_macro_pool_total();
    result.settings.pool_bytes_used = zmk_runtime_macro_pool_used();

    resp->which_response_type = cormoran_runtime_macro_Response_get_macro_global_settings_tag;
    resp->response_type.get_macro_global_settings = result;
}

static int handle_set_tap_ms(const cormoran_runtime_macro_SetTapMsRequest *req,
                             cormoran_runtime_macro_Response *resp) {
    if (req->tap_ms > ZMK_RUNTIME_MACRO_TAP_MS_MAX) {
        return -ERANGE;
    }

    int ret = zmk_custom_setting_write_by_key(
        ZMK_RUNTIME_MACRO_SUBSYSTEM_ID, ZMK_RUNTIME_MACRO_TAP_MS_KEY,
        &ZMK_CUSTOM_SETTING_VALUE_INT32(req->tap_ms), write_mode(req->persist));
    if (ret < 0) {
        return ret;
    }

    set_status(resp, 1, "Runtime macro tap_ms updated");
    return 0;
}

/* Every operational RPC (get/set-step-count/set-step/append-step) addresses
 * a macro by slot number; this resolves the slot to the name the underlying
 * zmk_runtime_macro_read/write() module API still takes and, on failure,
 * sets a slot-specific error message directly on `resp` (rather than letting
 * the generic -ERANGE/-ENOENT dispatch at the bottom of
 * runtime_macro_rpc_handle_request() run, since -ERANGE is ambiguous with
 * unrelated step-index/step-count range checks in the same handlers).
 * Returns -ERANGE if the slot is out of CONFIG_ZMK_RUNTIME_MACRO_COUNT
 * range, -ENOENT if the slot is currently unbound (no live macro there). */
static int resolve_slot_name(uint32_t slot, char *name, size_t name_capacity,
                             cormoran_runtime_macro_Response *resp) {
    int ret = zmk_runtime_macro_name_for_slot(slot, name, name_capacity);
    if (ret == -ERANGE) {
        set_error(resp, "Slot out of range");
    } else if (ret == -ENOENT) {
        set_error(resp, NO_MACRO_IN_SLOT);
    }
    return ret;
}

/* Staging for a streamed GetMacro reply. handle_get_macro() reads the macro
 * into this once; encode_macro_steps_cb() then streams each MacroStep submessage
 * out of it at pb_encode time. Because MacroDetail.steps is a pb_callback_t
 * (see the .options file), the response never materializes a steps[64] array
 * (~4.6 KB) - that array on the RPC thread stack is what overflowed the default
 * CONFIG_ZMK_STUDIO_RPC_THREAD_STACK_SIZE=4096 (watchdog K_ERR_STACK_CHK_FAIL on
 * hardware). 256 B (one macro), and safe as a single shared instance because the
 * Studio RPC dispatch is single-threaded: one request is in flight at a time,
 * the same invariant the static response buffer already relies on. */
static struct {
    uint8_t encoded[CONFIG_ZMK_RUNTIME_MACRO_MAX_BYTES];
    size_t size;
} get_macro_stream;

static bool encode_macro_steps_cb(pb_ostream_t *stream, const pb_field_t *field, void *const *arg) {
    ARG_UNUSED(arg);

    const uint8_t *encoded = get_macro_stream.encoded;
    size_t size = get_macro_stream.size;

    if (size == 0) {
        return true;
    }
    if (encoded[0] != ZMK_RUNTIME_MACRO_FORMAT_VERSION) {
        return false;
    }

    size_t offset = 1;
    while (offset < size) {
        cormoran_runtime_macro_MacroStep step;
        if (decode_one_step(encoded, size, &offset, &step) < 0) {
            return false;
        }
        if (!pb_encode_tag_for_field(stream, field)) {
            return false;
        }
        if (!pb_encode_submessage(stream, cormoran_runtime_macro_MacroStep_fields, &step)) {
            return false;
        }
    }

    return true;
}

static int handle_get_macro(const cormoran_runtime_macro_GetMacroRequest *req,
                            cormoran_runtime_macro_Response *resp) {
    char name[CONFIG_ZMK_RUNTIME_MACRO_NAME_MAX_LEN + 1];
    int ret = resolve_slot_name(req->slot, name, sizeof(name), resp);
    if (ret < 0) {
        return ret;
    }

    ret = zmk_runtime_macro_read(name, get_macro_stream.encoded, sizeof(get_macro_stream.encoded),
                                 &get_macro_stream.size);
    if (ret < 0) {
        return ret;
    }

    cormoran_runtime_macro_GetMacroResponse *result = &resp->response_type.get_macro;
    *result =
        (cormoran_runtime_macro_GetMacroResponse)cormoran_runtime_macro_GetMacroResponse_init_zero;
    result->has_macro = true;
    result->macro.slot = req->slot;
    snprintf(result->macro.name, sizeof(result->macro.name), "%s", name);
    result->macro.encoded_size = get_macro_stream.size;
    result->macro.steps.funcs.encode = encode_macro_steps_cb;

    resp->which_response_type = cormoran_runtime_macro_Response_get_macro_tag;

    return 0;
}

/* Read a macro's stored byte blob and validate its header. Returns the size via
 * *size; -EINVAL if a non-empty blob has the wrong format version. These edit
 * handlers rewrite the compact byte stream in place (two 256 B stack buffers),
 * never decoding into a MacroStep steps[64] (~4.6 KB) array. */
static int read_macro_blob(const char *name, uint8_t *encoded, size_t capacity, size_t *size) {
    int ret = zmk_runtime_macro_read(name, encoded, capacity, size);
    if (ret < 0) {
        return ret;
    }
    if (*size > 0 && encoded[0] != ZMK_RUNTIME_MACRO_FORMAT_VERSION) {
        return -EINVAL;
    }
    return 0;
}

static int handle_set_macro_step_count(const cormoran_runtime_macro_SetMacroStepCountRequest *req,
                                       cormoran_runtime_macro_Response *resp) {
    if (req->step_count > RUNTIME_MACRO_RPC_MAX_STEPS) {
        return -ERANGE;
    }

    char name[CONFIG_ZMK_RUNTIME_MACRO_NAME_MAX_LEN + 1];
    int ret = resolve_slot_name(req->slot, name, sizeof(name), resp);
    if (ret < 0) {
        return ret;
    }

    uint8_t in[CONFIG_ZMK_RUNTIME_MACRO_MAX_BYTES];
    size_t in_size = 0;
    ret = read_macro_blob(name, in, sizeof(in), &in_size);
    if (ret < 0) {
        return ret;
    }

    uint8_t out[CONFIG_ZMK_RUNTIME_MACRO_MAX_BYTES];
    out[0] = ZMK_RUNTIME_MACRO_FORMAT_VERSION;
    size_t out_off = 1;
    size_t in_off = (in_size > 0) ? 1 : 0;
    pb_size_t kept = 0;

    /* Copy the first min(existing, step_count) steps verbatim (truncating any
     * beyond step_count), then pad with delay(0) steps up to step_count. */
    while (in_off < in_size && kept < req->step_count) {
        size_t step_start = in_off;
        cormoran_runtime_macro_MacroStep step;
        ret = decode_one_step(in, in_size, &in_off, &step);
        if (ret < 0) {
            return ret;
        }
        size_t step_len = in_off - step_start;
        if (out_off + step_len > sizeof(out)) {
            return -ENOSPC;
        }
        memcpy(&out[out_off], &in[step_start], step_len);
        out_off += step_len;
        kept++;
    }
    while (kept < req->step_count) {
        cormoran_runtime_macro_MacroStep step =
            (cormoran_runtime_macro_MacroStep)cormoran_runtime_macro_MacroStep_init_zero;
        step.which_step = cormoran_runtime_macro_MacroStep_delay_tag;
        step.step.delay.delay_ms = 0;
        ret = encode_one_step(&step, out, sizeof(out), &out_off);
        if (ret < 0) {
            return ret;
        }
        kept++;
    }

    ret = zmk_runtime_macro_write(name, out, out_off, write_mode(req->persist));
    if (ret < 0) {
        return ret;
    }

    char message[96];
    snprintf(message, sizeof(message), "Macro \"%s\" (slot %u) step count updated", name,
             req->slot);
    set_status(resp, 1, message);

    return 0;
}

static int handle_set_macro_step(const cormoran_runtime_macro_SetMacroStepRequest *req,
                                 cormoran_runtime_macro_Response *resp) {
    if (!req->has_step) {
        return -EINVAL;
    }
    if (refuse_long_delay(&req->step, resp)) {
        return 0;
    }

    char name[CONFIG_ZMK_RUNTIME_MACRO_NAME_MAX_LEN + 1];
    int ret = resolve_slot_name(req->slot, name, sizeof(name), resp);
    if (ret < 0) {
        return ret;
    }

    uint8_t in[CONFIG_ZMK_RUNTIME_MACRO_MAX_BYTES];
    size_t in_size = 0;
    ret = read_macro_blob(name, in, sizeof(in), &in_size);
    if (ret < 0) {
        return ret;
    }

    uint8_t out[CONFIG_ZMK_RUNTIME_MACRO_MAX_BYTES];
    out[0] = ZMK_RUNTIME_MACRO_FORMAT_VERSION;
    size_t out_off = 1;
    size_t in_off = (in_size > 0) ? 1 : 0;
    pb_size_t index = 0;
    bool replaced = false;

    /* Rewrite the stream, substituting the target step and copying the rest
     * byte-for-byte. */
    while (in_off < in_size) {
        size_t step_start = in_off;
        cormoran_runtime_macro_MacroStep step;
        ret = decode_one_step(in, in_size, &in_off, &step);
        if (ret < 0) {
            return ret;
        }
        if (index == req->step_index) {
            ret = encode_one_step(&req->step, out, sizeof(out), &out_off);
            if (ret < 0) {
                return ret;
            }
            replaced = true;
        } else {
            size_t step_len = in_off - step_start;
            if (out_off + step_len > sizeof(out)) {
                return -ENOSPC;
            }
            memcpy(&out[out_off], &in[step_start], step_len);
            out_off += step_len;
        }
        index++;
    }
    if (!replaced) {
        return -ERANGE;
    }

    ret = zmk_runtime_macro_write(name, out, out_off, write_mode(req->persist));
    if (ret < 0) {
        return ret;
    }

    char message[96];
    snprintf(message, sizeof(message), "Macro \"%s\" (slot %u) step %u updated", name, req->slot,
             req->step_index);
    set_status(resp, 1, message);

    return 0;
}

static int handle_append_macro_step(const cormoran_runtime_macro_AppendMacroStepRequest *req,
                                    cormoran_runtime_macro_Response *resp) {
    if (!req->has_step) {
        return -EINVAL;
    }
    if (refuse_long_delay(&req->step, resp)) {
        return 0;
    }

    char name[CONFIG_ZMK_RUNTIME_MACRO_NAME_MAX_LEN + 1];
    int ret = resolve_slot_name(req->slot, name, sizeof(name), resp);
    if (ret < 0) {
        return ret;
    }

    uint8_t encoded[CONFIG_ZMK_RUNTIME_MACRO_MAX_BYTES];
    size_t size = 0;
    ret = read_macro_blob(name, encoded, sizeof(encoded), &size);
    if (ret < 0) {
        return ret;
    }

    /* Append the new step's bytes onto the existing blob - no need to decode the
     * steps already there. A freshly created macro is just the version byte. */
    size_t offset = size;
    if (size == 0) {
        encoded[0] = ZMK_RUNTIME_MACRO_FORMAT_VERSION;
        offset = 1;
    }
    ret = encode_one_step(&req->step, encoded, sizeof(encoded), &offset);
    if (ret < 0) {
        return ret;
    }

    ret = zmk_runtime_macro_write(name, encoded, offset, write_mode(req->persist));
    if (ret < 0) {
        return ret;
    }

    pb_size_t total = 0;
    (void)count_steps(encoded, offset, &total);

    char message[96];
    snprintf(message, sizeof(message), "Macro \"%s\" (slot %u) step appended", name, req->slot);
    set_status(resp, total, message);

    return 0;
}

static int handle_save_macros(cormoran_runtime_macro_Response *resp) {
    uint32_t affected_count = 0;
    int ret =
        zmk_custom_settings_save_scope(ZMK_RUNTIME_MACRO_SUBSYSTEM_ID, NULL, NULL, &affected_count);
    if (ret < 0) {
        return ret;
    }

    set_status(resp, affected_count, "Runtime macro settings saved");
    return 0;
}

static int handle_discard_macros(cormoran_runtime_macro_Response *resp) {
    uint32_t affected_count = 0;
    int ret = zmk_custom_settings_discard_scope(ZMK_RUNTIME_MACRO_SUBSYSTEM_ID, NULL, NULL,
                                                &affected_count);
    if (ret < 0) {
        return ret;
    }

    set_status(resp, affected_count, "Runtime macro settings discarded");
    return 0;
}

/* Map the errno a create/delete/rename returns to a clear, actionable
 * message and set it on `resp` directly (returning 0 so the generic errno
 * dispatch at the bottom of runtime_macro_rpc_handle_request() does not
 * overwrite it). Returns `ret` unchanged if it is not one of the known cases
 * (let the caller return it for the generic path). */
static int set_lifecycle_error(cormoran_runtime_macro_Response *resp, int ret) {
    switch (ret) {
    case -EEXIST:
        set_error(resp, "A macro with that name already exists");
        return 0;
    case -ENOENT:
        set_error(resp, "No macro with that name");
        return 0;
    case -ENAMETOOLONG:
        set_error(resp, "Macro name is too long");
        return 0;
    case -ENOSPC:
        set_error(resp, "No space for another macro: delete one, or free the pool");
        return 0;
    case -EINVAL:
        set_error(resp, "Invalid macro name");
        return 0;
    default:
        return ret;
    }
}

static int handle_create_macro(const cormoran_runtime_macro_CreateMacroRequest *req,
                               cormoran_runtime_macro_Response *resp) {
    if (req->name[0] == '\0') {
        set_error(resp, "Macro name must not be empty");
        return 0;
    }

    /* A fresh macro is just the format-version header with no steps; the
     * client adds steps afterwards with AppendMacroStep. */
    const uint8_t empty_body[] = {ZMK_RUNTIME_MACRO_FORMAT_VERSION};
    uint32_t slot = 0;
    int ret = zmk_runtime_macro_create(req->name, empty_body, sizeof(empty_body),
                                       write_mode(req->persist), &slot);
    if (ret < 0) {
        return set_lifecycle_error(resp, ret);
    }

    char message[96];
    snprintf(message, sizeof(message), "Macro \"%s\" created (slot %u)", req->name, slot);
    set_status(resp, 1, message);
    return 0;
}

static int handle_delete_macro(const cormoran_runtime_macro_DeleteMacroRequest *req,
                               cormoran_runtime_macro_Response *resp) {
    if (req->name[0] == '\0') {
        set_error(resp, "Macro name must not be empty");
        return 0;
    }

    int ret = zmk_runtime_macro_delete(req->name);
    if (ret < 0) {
        return set_lifecycle_error(resp, ret);
    }

    char message[96];
    snprintf(message, sizeof(message), "Macro \"%s\" deleted", req->name);
    set_status(resp, 1, message);
    return 0;
}

static int handle_rename_macro(const cormoran_runtime_macro_RenameMacroRequest *req,
                               cormoran_runtime_macro_Response *resp) {
    if (req->old_name[0] == '\0' || req->new_name[0] == '\0') {
        set_error(resp, "Macro name must not be empty");
        return 0;
    }

    int ret = zmk_runtime_macro_rename(req->old_name, req->new_name, write_mode(req->persist));
    if (ret < 0) {
        return set_lifecycle_error(resp, ret);
    }

    char message[96];
    snprintf(message, sizeof(message), "Macro renamed to \"%s\"", req->new_name);
    set_status(resp, 1, message);
    return 0;
}

/* Reset the macro at `req->slot` to its compile-time state: overwrite it with
 * its devicetree default body if one exists for its name, otherwise delete it
 * (a macro with no compile-time default "resets" to not existing). */
static int handle_reset_macro(const cormoran_runtime_macro_ResetMacroRequest *req,
                              cormoran_runtime_macro_Response *resp) {
    char name[CONFIG_ZMK_RUNTIME_MACRO_NAME_MAX_LEN + 1];
    int ret = resolve_slot_name(req->slot, name, sizeof(name), resp);
    if (ret < 0) {
        return ret;
    }

    uint8_t encoded[CONFIG_ZMK_RUNTIME_MACRO_MAX_BYTES];
    size_t size = 0;
    ret = zmk_runtime_macro_default_encode(name, encoded, sizeof(encoded), &size);

    char message[96];
    if (ret == -ENOENT) {
        /* No compile-time default for this name: resetting means deleting it. */
        ret = zmk_runtime_macro_delete(name);
        if (ret < 0) {
            return ret;
        }
        snprintf(message, sizeof(message),
                 "Macro \"%s\" (slot %u) has no compile-time default; deleted", name, req->slot);
        set_status(resp, 1, message);
        return 0;
    }
    if (ret < 0) {
        return ret;
    }

    ret = zmk_runtime_macro_write(name, encoded, size, write_mode(req->persist));
    if (ret < 0) {
        return ret;
    }

    snprintf(message, sizeof(message), "Macro \"%s\" (slot %u) reset to compile-time default", name,
             req->slot);
    set_status(resp, 1, message);
    return 0;
}

/* Whether a request may only run while Studio is unlocked. ListMacros and
 * GetMacroGlobalSettings expose only metadata (slots, names, sizes, unsaved
 * flags, global limits) and stay readable when locked; GetMacro reveals a
 * macro's actual steps, and every mutating RPC changes stored macros, so both
 * require an unlocked session. Unknown request types default to requiring
 * unlock (fail closed). */
static bool request_requires_unlock(pb_size_t which_request_type) {
    switch (which_request_type) {
    case cormoran_runtime_macro_Request_list_macros_tag:
    case cormoran_runtime_macro_Request_get_macro_global_settings_tag:
        return false;
    default:
        return true;
    }
}

static bool runtime_macro_rpc_handle_request(const zmk_custom_CallRequest *raw_request,
                                             pb_callback_t *encode_response) {
    cormoran_runtime_macro_Response *resp =
        ZMK_RPC_CUSTOM_SUBSYSTEM_RESPONSE_BUFFER_ALLOCATE(cormoran__runtime_macro, encode_response);

    cormoran_runtime_macro_Request req = cormoran_runtime_macro_Request_init_zero;
    pb_istream_t req_stream =
        pb_istream_from_buffer(raw_request->payload.bytes, raw_request->payload.size);

    if (!pb_decode(&req_stream, cormoran_runtime_macro_Request_fields, &req)) {
        LOG_WRN("Failed to decode runtime macro request: %s", PB_GET_ERROR(&req_stream));
        set_error(resp, "Failed to decode request");
        return true;
    }

    /* The subsystem is UNSECURED so ListMacros/GetMacroGlobalSettings answer
     * while locked; gate the content-reading and mutating requests here. */
    if (request_requires_unlock(req.which_request_type) &&
        zmk_studio_core_get_lock_state() != ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED) {
        set_error(resp, "Studio must be unlocked to read or edit macro contents");
        return true;
    }

    int ret = 0;

    /* Our mutating handlers write macros through the custom-settings core API,
     * which raises a "setting changed" event that the custom-settings Studio
     * layer turns into its own notification. That notification is redundant
     * here (this RPC's own response already confirms the change to the single
     * Studio client), and its listener runs synchronously in this thread and
     * pb_encodes the notification: at the default CONFIG_ZMK_STUDIO_RPC_THREAD_
     * STACK_SIZE (4096) that extra encode depth OVERFLOWS the RPC thread stack
     * on real hardware (MemManage / watchdog K_ERR_STACK_CHK_FAIL - observed on
     * a XIAO nRF52840 running CreateMacro), and even with headroom it competes
     * with the pending response on the shared transport. Suppress it for the
     * whole dispatch, exactly as custom-settings brackets its own RPC entry
     * point. Read-only requests raise no event, so bracketing them is harmless. */
    zmk_custom_settings_notify_suppress_begin();

    switch (req.which_request_type) {
    case cormoran_runtime_macro_Request_list_macros_tag:
        ret = handle_list_macros(resp);
        break;
    case cormoran_runtime_macro_Request_get_macro_tag:
        ret = handle_get_macro(&req.request_type.get_macro, resp);
        break;
    case cormoran_runtime_macro_Request_set_macro_step_count_tag:
        ret = handle_set_macro_step_count(&req.request_type.set_macro_step_count, resp);
        break;
    case cormoran_runtime_macro_Request_get_macro_global_settings_tag:
        handle_get_macro_global_settings(resp);
        break;
    case cormoran_runtime_macro_Request_set_tap_ms_tag:
        ret = handle_set_tap_ms(&req.request_type.set_tap_ms, resp);
        break;
    case cormoran_runtime_macro_Request_set_macro_step_tag:
        ret = handle_set_macro_step(&req.request_type.set_macro_step, resp);
        break;
    case cormoran_runtime_macro_Request_append_macro_step_tag:
        ret = handle_append_macro_step(&req.request_type.append_macro_step, resp);
        break;
    case cormoran_runtime_macro_Request_create_macro_tag:
        ret = handle_create_macro(&req.request_type.create_macro, resp);
        break;
    case cormoran_runtime_macro_Request_delete_macro_tag:
        ret = handle_delete_macro(&req.request_type.delete_macro, resp);
        break;
    case cormoran_runtime_macro_Request_rename_macro_tag:
        ret = handle_rename_macro(&req.request_type.rename_macro, resp);
        break;
    case cormoran_runtime_macro_Request_reset_macro_tag:
        ret = handle_reset_macro(&req.request_type.reset_macro, resp);
        break;
    case cormoran_runtime_macro_Request_save_macros_tag:
        ret = handle_save_macros(resp);
        break;
    case cormoran_runtime_macro_Request_discard_macros_tag:
        ret = handle_discard_macros(resp);
        break;
    default:
        ret = -ENOTSUP;
        break;
    }

    zmk_custom_settings_notify_suppress_end();

    if (ret < 0 && resp->which_response_type != cormoran_runtime_macro_Response_error_tag) {
        /* resolve_slot_name() already sets a slot-specific error directly on
         * `resp` for its own -ERANGE/-ENOENT (see its doc comment) - the
         * guard above avoids clobbering that with the generic messages
         * below, which cover errors from everything else (e.g. -ENOENT from
         * a raw name-keyed module call, or -ERANGE from an out-of-bounds
         * step_index/step_count that has nothing to do with slot
         * resolution). -ENOSPC from a body write means the shared
         * name+body pool (CONFIG_ZMK_RUNTIME_MACRO_POOL_BYTES) is exhausted -
         * give a clear, actionable message instead of the generic errno
         * text; every other failure keeps the generic format. */
        if (ret == -ENOSPC) {
            set_error(resp, "Macro pool full: delete or shrink another macro");
        } else if (ret == -ENOENT) {
            set_error(resp, NO_MACRO_IN_SLOT);
        } else {
            char message[sizeof(resp->response_type.error.message)];
            snprintf(message, sizeof(message), "Runtime macro RPC failed: %d", ret);
            set_error(resp, message);
        }
    }

    return true;
}
