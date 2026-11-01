/* SPDX-License-Identifier: MIT */
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <zephyr/device.h>
#include <zephyr/kernel.h>
#include <zephyr/sys/atomic.h>
#include <dt-bindings/zmk/keys.h>
#include <cormoran/zmk/runtime_macro.h>
#include <zmk/behavior_queue.h>

static atomic_t presses;
static atomic_t releases;
static atomic_t held;

int __real_zmk_behavior_invoke_binding(const struct zmk_behavior_binding *binding,
                                       struct zmk_behavior_binding_event event, bool pressed);

int __wrap_zmk_behavior_invoke_binding(const struct zmk_behavior_binding *binding,
                                       struct zmk_behavior_binding_event event, bool pressed) {
    if (strcmp(binding->behavior_dev, DEVICE_DT_NAME(DT_NODELABEL(kp))) == 0 &&
        binding->param1 == A) {
        atomic_inc(pressed ? &presses : &releases);
        atomic_add(&held, pressed ? 1 : -1);
    }
    return __real_zmk_behavior_invoke_binding(binding, event, pressed);
}

static void run_playback_test(void *a, void *b, void *c) {
    ARG_UNUSED(a);
    ARG_UNUSED(b);
    ARG_UNUSED(c);
    uint8_t encoded[36] = {ZMK_RUNTIME_MACRO_FORMAT_VERSION, ZMK_RUNTIME_MACRO_OP_KEY_TAP_SEQUENCE,
                           33};
    memset(&encoded[3], 4, 33);
    uint32_t slot;
    __ASSERT_NO_MSG(zmk_runtime_macro_create("Queue Release", encoded, sizeof(encoded),
                                             ZMK_CUSTOM_SETTING_WRITE_MODE_MEMORY, &slot) == 0);
    struct zmk_behavior_binding_event event = {.position = 0, .timestamp = k_uptime_get()};
    __ASSERT_NO_MSG(zmk_runtime_macro_play(slot, &event) == 0);
    k_sleep(K_MSEC(100));
    __ASSERT_NO_MSG(zmk_runtime_macro_play(slot, &event) == -EBUSY);
    k_sleep(K_MSEC(1200));
    __ASSERT_NO_MSG(atomic_get(&presses) == 33 && atomic_get(&releases) == 33);
    __ASSERT_NO_MSG(atomic_get(&held) == 0);

    const uint8_t one_tap[] = {ZMK_RUNTIME_MACRO_FORMAT_VERSION,
                               ZMK_RUNTIME_MACRO_OP_KEY_TAP_SEQUENCE, 1, 4};
    __ASSERT_NO_MSG(zmk_runtime_macro_write("Queue Release", one_tap, sizeof(one_tap),
                                            ZMK_CUSTOM_SETTING_WRITE_MODE_MEMORY) == 0);
    const struct zmk_behavior_binding wait = {.behavior_dev = "runtime_macro_wait"};
    __ASSERT_NO_MSG(zmk_behavior_queue_add(&event, wait, true, 500) == 0);
    __ASSERT_NO_MSG(zmk_runtime_macro_play(slot, &event) == 0);
    k_sleep(K_MSEC(100));
    // The prior queue's wait is still running; an estimated 30ms completion
    // would allow a second macro to overlap before the first one even starts.
    __ASSERT_NO_MSG(zmk_runtime_macro_play(slot, &event) == -EBUSY);
    __ASSERT_NO_MSG(atomic_get(&presses) == 33 && atomic_get(&releases) == 33);
    k_sleep(K_MSEC(500));
    __ASSERT_NO_MSG(atomic_get(&presses) == 34 && atomic_get(&releases) == 34);
    __ASSERT_NO_MSG(zmk_runtime_macro_play(slot, &event) == 0);
    k_sleep(K_MSEC(100));
    __ASSERT_NO_MSG(atomic_get(&presses) == 35 && atomic_get(&releases) == 35);
    __ASSERT_NO_MSG(atomic_get(&held) == 0);
    printk("PASS: runtime_macro_playback_queue\n");
    exit(0);
}

K_THREAD_DEFINE(runtime_macro_playback_test, 4096, run_playback_test, NULL, NULL, NULL,
                K_LOWEST_APPLICATION_THREAD_PRIO, 0, 100);
