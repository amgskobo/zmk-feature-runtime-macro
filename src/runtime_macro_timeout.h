/* SPDX-License-Identifier: MIT */
#pragma once
#include <stdint.h>
#include <zephyr/sys_clock.h>

/* Keep all uint32 millisecond intervals and the kernel tick ABI. Fractional
 * products fit uint32; seconds are widened only for the required tick result. */
static inline k_ticks_t runtime_macro_timeout_ticks(uint32_t ms, uint32_t hz) {
    if (hz == 0U) {
        return 0;
    }
    if (ms <= (UINT32_MAX - 999U) / hz) {
        return ((uint32_t)ms * hz + 999U) / 1000U;
    }
    const uint32_t seconds = ms / 1000U;
    const uint32_t remainder = ms % 1000U;
    const uint32_t fraction = remainder * (hz / 1000U) + (remainder * (hz % 1000U) + 999U) / 1000U;
    return (k_ticks_t)seconds * hz + fraction;
}
