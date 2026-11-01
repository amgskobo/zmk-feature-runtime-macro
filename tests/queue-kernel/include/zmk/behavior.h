#pragma once
#include <stdbool.h>
#include <stdint.h>
struct zmk_behavior_binding {
    const char *behavior_dev;
    uint32_t param1;
    uint32_t param2;
};
struct zmk_behavior_binding_event {
    uint32_t position;
    int64_t timestamp;
};
int zmk_behavior_invoke_binding(const struct zmk_behavior_binding *binding,
                                struct zmk_behavior_binding_event event, bool pressed);
int review_queue(unsigned taps, uint32_t *duration);
