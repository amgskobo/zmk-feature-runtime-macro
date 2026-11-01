#include <stdlib.h>
#include <string.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zmk/behavior.h>

LOG_MODULE_REGISTER(zmk, CONFIG_ZMK_LOG_LEVEL);
static int held;
static unsigned invoked;

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
    uint32_t duration;
    int ret = review_queue(taps, &duration);
    k_sleep(K_MSEC(2000));
    printk("real kernel: taps=%u, ret=%d, invoked=%u, held=%d, duration=%u\n", taps, ret, invoked,
           held, duration);
    exit(ret == 0 && held == 0 && invoked == taps * 2 ? 0 : 1);
    return 0;
}
