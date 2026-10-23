/*
 * Copyright (c) 2026 cormoran
 *
 * SPDX-License-Identifier: MIT
 */

#pragma once

#include <errno.h>
#include <stddef.h>
#include <stdint.h>

/* Unsigned LEB128 shared by playback, the Studio step editor and the
 * devicetree defaults, so all three accept exactly the same bodies. A uint32
 * takes at most five bytes, the fifth carrying only its top four bits. */
static inline int runtime_macro_read_uvar(const uint8_t *encoded, size_t size, size_t *offset,
                                          uint32_t *value) {
    uint32_t result = 0;

    for (uint8_t shift = 0; *offset < size && shift <= 28; shift += 7) {
        uint8_t byte = encoded[(*offset)++];
        if (shift == 28 && (byte & 0xf0) != 0) {
            return -EINVAL;
        }
        result |= (uint32_t)(byte & 0x7f) << shift;
        if ((byte & 0x80) == 0) {
            *value = result;
            return 0;
        }
    }

    return -EINVAL;
}

static inline int runtime_macro_append_uvar(uint8_t *dest, size_t capacity, size_t *offset,
                                            uint32_t value) {
    do {
        if (*offset >= capacity) {
            return -ENOSPC;
        }
        uint8_t byte = value & 0x7f;
        value >>= 7;
        dest[(*offset)++] = value != 0 ? (byte | 0x80) : byte;
    } while (value != 0);

    return 0;
}
