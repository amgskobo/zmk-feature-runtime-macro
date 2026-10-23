/* SPDX-License-Identifier: MIT */
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <zephyr/kernel.h>
#include <dt-bindings/zmk/keys.h>
#include <cormoran/zmk/runtime_macro.h>
#include <zmk/event_manager.h>
#include <zmk/events/keycode_state_changed.h>
#include <zmk/hid.h>

struct edge {
    uint32_t usage;
    bool pressed;
};
static struct edge edges[16];
static size_t edge_count;

static int record_key(const zmk_event_t *eh) {
    const struct zmk_keycode_state_changed *event = as_zmk_keycode_state_changed(eh);
    if (event == NULL) {
        return ZMK_EV_EVENT_BUBBLE;
    }
    __ASSERT_NO_MSG(edge_count < ARRAY_SIZE(edges));
    edges[edge_count++] = (struct edge){event->keycode, event->state};
    printf("edge time=%lld usage=%u pressed=%u\n", (long long)k_uptime_get(), event->keycode,
           event->state);
    return ZMK_EV_EVENT_BUBBLE;
}
ZMK_LISTENER(runtime_macro_pressure_keys, record_key);
ZMK_SUBSCRIPTION(runtime_macro_pressure_keys, zmk_keycode_state_changed);

static void exercise(void *a, void *b, void *c) {
    ARG_UNUSED(a);
    ARG_UNUSED(b);
    ARG_UNUSED(c);
    k_sleep(K_MSEC(100));
    const char *scenario = getenv("RUNTIME_MACRO_PRESSURE_CASE");
    bool held = scenario && strcmp(scenario, "held") == 0;
    bool deleted = scenario && strcmp(scenario, "delete") == 0;
    uint32_t slot;
    __ASSERT_NO_MSG(zmk_runtime_macro_slot_for_name(held ? "held" : "taps", &slot) == 0);
    struct zmk_behavior_binding_event event = {.position = 0, .timestamp = k_uptime_get()};
    __ASSERT_NO_MSG(zmk_runtime_macro_play(slot, &event) == 0);
    k_sleep(K_MSEC(5));
    __ASSERT_NO_MSG(zmk_runtime_macro_play(slot, &event) == -EBUSY);
    if (deleted) {
        __ASSERT_NO_MSG(zmk_runtime_macro_delete("taps") == 0);
    }
    k_sleep(K_MSEC(200));
    const struct edge taps[] = {{4, true},  {4, false}, {5, true},
                                {5, false}, {6, true},  {6, false}};
    const struct edge hold[] = {{0xe1, true}, {4, true}, {4, false}, {0xe1, false}};
    const struct edge *expected = held ? hold : taps;
    size_t count = held ? ARRAY_SIZE(hold) : ARRAY_SIZE(taps);
    __ASSERT(edge_count == count, "Incomplete macro under pressure: edges=%u expected=%u",
             (unsigned)edge_count, (unsigned)count);
    for (size_t i = 0; i < count; ++i) {
        __ASSERT_NO_MSG(edges[i].usage == expected[i].usage &&
                        edges[i].pressed == expected[i].pressed);
    }
    __ASSERT_NO_MSG(!zmk_hid_is_pressed(A));
    __ASSERT_NO_MSG(!zmk_hid_is_pressed(B));
    __ASSERT_NO_MSG(!zmk_hid_is_pressed(C));
    __ASSERT_NO_MSG(zmk_hid_get_keyboard_report()->body.modifiers == 0);
    printf("PASS runtime macro queue pressure scenario=%s ordered=%u released=1\n",
           held      ? "held"
           : deleted ? "delete"
                     : "taps",
           (unsigned)count);
    exit(0);
}
K_THREAD_DEFINE(runtime_macro_pressure_thread, 4096, exercise, NULL, NULL, NULL, 5, 0, 0);
