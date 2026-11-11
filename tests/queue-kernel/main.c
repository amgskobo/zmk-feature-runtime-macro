#include <stdlib.h>
#include <string.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zmk/behavior.h>
#include <zmk/behavior_queue.h>

LOG_MODULE_REGISTER(zmk, CONFIG_ZMK_LOG_LEVEL);
static int held;
static unsigned invoked;
static uint32_t accepted_wait_ms;

int __real_zmk_behavior_queue_add(const struct zmk_behavior_binding_event *event,
                                  const struct zmk_behavior_binding binding, bool press,
                                  uint32_t wait);

int __wrap_zmk_behavior_queue_add(const struct zmk_behavior_binding_event *event,
                                  const struct zmk_behavior_binding binding, bool press,
                                  uint32_t wait) {
    int ret = __real_zmk_behavior_queue_add(event, binding, press, wait);
    if (ret == 0) {
        accepted_wait_ms += wait;
    }
    return ret;
}

int zmk_behavior_invoke_binding(const struct zmk_behavior_binding *binding,
                                struct zmk_behavior_binding_event event, bool pressed) {
    ARG_UNUSED(event);
    if (strcmp(binding->behavior_dev, "key_press") == 0) {
        held += pressed ? 1 : -1;
        invoked++;
    }
    return 0;
}

int main(void) {
    const char *selection = getenv("REVIEW_TAPS");
    unsigned taps = selection ? strtoul(selection, NULL, 10) : 33;
    int ret = review_queue(taps);
    k_sleep(K_MSEC(2000));
    printk("real kernel: taps=%u, ret=%d, invoked=%u, held=%d, accepted wait=%u\n", taps, ret,
           invoked, held, accepted_wait_ms);
    exit(ret == 0 && held == 0 && invoked == taps * 2 && accepted_wait_ms == taps * 30 ? 0 : 1);
    return 0;
}
