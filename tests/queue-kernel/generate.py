"""Lift unchanged owner queue helpers; the native app links real DYA queue.c."""

from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "review"))
from test_playback_regressions import declaration, function

source = Path(__file__).resolve().parents[2] / "src/runtime_macro.c"
text = r"""
#include <errno.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zmk/behavior_queue.h>
LOG_MODULE_DECLARE(zmk, CONFIG_ZMK_LOG_LEVEL);
#define RUNTIME_MACRO_WAIT_BEHAVIOR_NAME "runtime_macro_wait"
#define RUNTIME_MACRO_COMPLETE_PARAM 1U
#define CONFIG_ZMK_RUNTIME_MACRO_QUEUE_SIZE 64
static uint32_t zmk_runtime_macro_tap_ms(void) { return 30; }
"""
text += declaration(source, "struct", "runtime_macro_queue_item")
text += declaration(source, "struct", "runtime_macro_queue_state")
for name in ("queue_behavior", "add_saturating_delay", "queue_runtime_macro"):
    text += function(source, name)
text += r"""
int review_queue(unsigned taps, uint32_t *duration) {
    struct runtime_macro_queue_item items[64] = {0};
    if (taps > 64) return -EINVAL;
    for (unsigned i=0; i<taps; i++) {
        items[i]=(struct runtime_macro_queue_item){.is_tap=true,
            .binding={.behavior_dev="key_press", .param1=0x70004}};
    }
    struct runtime_macro_queue_state state={0};
    *duration=0;
    int ret;
    do {
        ret=queue_runtime_macro(items,taps,&(struct zmk_behavior_binding_event){0},&state,duration);
        if (ret==-ENOMSG || ret==-EAGAIN) k_sleep(K_MSEC(1));
    } while (ret==-ENOMSG || ret==-EAGAIN);
    return ret;
}
"""
Path(sys.argv[1]).write_text(text)
