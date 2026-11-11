"""Owner review regressions using actual encoder/player and DYA queue bodies.

ZMK_ROOT selects an unchanged resolved DYA checkout. Kernel queue/timer effects
are controlled stand-ins here; real scheduling requires the native fixture.
"""

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


def function(path, name):
    text = path.read_text()
    for match in re.finditer(
        r"^(?:static )?[^\n;{}]*\b" + re.escape(name) + r"\(", text, re.M
    ):
        closing = text.index(")", match.end())
        if not text[closing + 1 :].lstrip().startswith("{"):
            continue
        opening = text.index("{", closing)
        depth = 0
        for token in re.finditer(
            r'/\*.*?\*/|//[^\n]*|"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|[{}]',
            text[opening:],
            re.S,
        ):
            if token.group() == "{":
                depth += 1
            elif token.group() == "}":
                depth -= 1
                if depth == 0:
                    start = match.start()
                    if not text[start : match.end() - len(name) - 1].strip():
                        start = text.rfind("\n", 0, start - 1) + 1
                    line = text.count("\n", 0, start) + 1
                    return (
                        f'#line {line} "{path}"\n'
                        + text[start : opening + token.end()]
                        + "\n"
                    )
    raise ValueError("missing function: " + name)


def declaration(path, kind, name):
    return (
        re.search(
            r"^" + kind + " " + name + r" \{.*?^\};", path.read_text(), re.M | re.S
        ).group()
        + "\n"
    )


PREFIX = r"""
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#define BIT(n) (1U << (n))
#include <dt-bindings/zmk/keys.h>
#define IS_ENABLED(x) 0
#define CONFIG_ZMK_RUNTIME_MACRO_MAX_BYTES 256
#define CONFIG_ZMK_RUNTIME_MACRO_QUEUE_SIZE 64
#define K_NO_WAIT 0
#define K_MSEC(x) (x)
#define LOG_DBG(...) ((void)0)
#define LOG_WRN(...) ((void)0)
#define LOG_ERR(...) ((void)0)
#define RUNTIME_MACRO_WAIT_BEHAVIOR_NAME "runtime_macro_wait"
#define RUNTIME_MACRO_COMPLETE_PARAM 1U
#define RUNTIME_MACRO_DEFAULT_TAP_MODE_NAME "tap"
#define RUNTIME_MACRO_DEFAULT_PRESS_MODE_NAME "press"
#define RUNTIME_MACRO_DEFAULT_RELEASE_MODE_NAME "release"
#define RUNTIME_MACRO_DEFAULT_WAIT_TIME_NAME "wait"
#define RUNTIME_MACRO_DEFAULT_KP_NAME "key_press"
#define RUNTIME_MACRO_PACKED_KEY_LSFT BIT(7)
#define RUNTIME_MACRO_PACKED_KEY_USAGE_MASK 0x7f
#define RUNTIME_MACRO_PACKED_KEY_MIN_USAGE 0x04
#define RUNTIME_MACRO_PACKED_KEY_MAX_USAGE 0x38
#define ZMK_RUNTIME_MACRO_FORMAT_VERSION 1
#define ZMK_RUNTIME_MACRO_OP_DOWN 1
#define ZMK_RUNTIME_MACRO_OP_UP 2
#define ZMK_RUNTIME_MACRO_OP_TAP 3
#define ZMK_RUNTIME_MACRO_OP_DELAY 4
#define ZMK_RUNTIME_MACRO_OP_KEY_TAP_SEQUENCE 5
#define ZMK_RUNTIME_MACRO_KEY_TAP_SEQUENCE_MAX_KEYS 64
#define ARRAY_SIZE(a) (sizeof(a) / sizeof((a)[0]))
typedef uint16_t zmk_behavior_local_id_t;
struct zmk_behavior_binding { const char *behavior_dev; uint32_t param1,param2; };
struct zmk_behavior_binding_event { uint32_t position; int64_t timestamp; };
struct k_work { int unused; };
struct k_work_delayable { struct k_work work; bool pending; };
static struct k_work_delayable queue_work;
static uint32_t zmk_runtime_macro_tap_ms(void) { return 30; }
static zmk_behavior_local_id_t zmk_behavior_get_local_id(const char *name) { (void)name; return 1; }
static int64_t k_uptime_get(void) { return 100; }
static bool k_work_delayable_is_pending(struct k_work_delayable *w) { return w->pending; }
static int k_work_schedule(struct k_work_delayable *w, uint32_t delay) { (void)delay; w->pending=true; return 1; }
static int held, invoked;
static int zmk_behavior_invoke_binding(const struct zmk_behavior_binding *b, struct zmk_behavior_binding_event e, bool pressed) {
    (void)e; if (strcmp(b->behavior_dev,"key_press")==0) { held += pressed ? 1 : -1; invoked++; } return 0;
}
"""

KERNEL_QUEUE = r"""
static struct q_item queued[64];
static int zmk_behavior_queue_msgq;
static unsigned head, used, queue_limit=64;
static uint32_t accepted_wait_ms;
static struct q_item accepted[132];
static size_t accepted_count;
static int k_msgq_put(int *q, const struct q_item *item, int wait) {
    (void)q; (void)wait;
    if (used==queue_limit) return -ENOMSG;
    assert(accepted_count<ARRAY_SIZE(accepted));
    accepted[accepted_count++]=*item;
    accepted_wait_ms+=item->wait;
    queued[(head+used)%64]=*item; used++; return 0;
}
static int k_msgq_get(int *q, struct q_item *item, int wait) {
    (void)q; (void)wait;
    if (!used) return -ENOMSG;
    *item=queued[head]; head=(head+1)%64; used--; return 0;
}
"""

SCENARIO = r"""
#line 1 "review-macro-scenarios.c"
int main(int argc,char **argv) {
    assert(argc==2); setbuf(stdout,NULL);
    if (strncmp(argv[1],"queue-",6)==0) {
        unsigned count=atoi(argv[1]+6);
        struct runtime_macro_queue_item items[64]={0};
        for (unsigned i=0;i<count;i++) items[i]=(struct runtime_macro_queue_item){.is_tap=true,.binding={.behavior_dev="key_press",.param1=A}};
        struct runtime_macro_queue_state state={0};
        int ret;
        do {
            ret=queue_runtime_macro(items,count,&(struct zmk_behavior_binding_event){0},&state);
            if (ret==-ENOMSG || ret==-EAGAIN) {
                queue_work.pending=false;
                behavior_queue_process_next(&queue_work.work);
            }
        } while (ret==-ENOMSG || ret==-EAGAIN);
        assert(queue_runtime_macro(items,count,&(struct zmk_behavior_binding_event){0},&state)==0);
        while (queue_work.pending || used) { queue_work.pending=false; behavior_queue_process_next(&queue_work.work); }
        printf("taps=%u, ret=%d, invoked=%d, held=%d, accepted wait=%u\n",count,ret,invoked,held,accepted_wait_ms);
        assert(ret==0 && held==0 && invoked==(int)count*2);
        assert(accepted_wait_ms==count*30 && accepted_count==count*2+1);
    } else if (strcmp(argv[1],"mixed")==0) {
        struct runtime_macro_queue_item items[]={
            {.is_delay=true,.delay_ms=17},
            {.is_delay=true,.delay_ms=23},
            {.pressed=true,.binding={.behavior_dev="key_press",.param1=A,.param2=UINT32_MAX}},
            {.is_delay=true,.delay_ms=5},
            {.is_delay=true,.delay_ms=7},
            {.is_tap=true,.binding={.behavior_dev="key_press",.param1=B,.param2=UINT32_MAX-1}},
            {.is_delay=true,.delay_ms=9},
            {.binding={.behavior_dev="key_press",.param1=A,.param2=UINT32_MAX}},
            {.is_delay=true,.delay_ms=11},
            {.is_delay=true,.delay_ms=13},
        };
        queue_limit=1;
        struct runtime_macro_queue_state state={0};
        int ret;
        do {
            ret=queue_runtime_macro(items,ARRAY_SIZE(items),&(struct zmk_behavior_binding_event){.position=42},&state);
            if (ret==-ENOMSG || ret==-EAGAIN) {
                queue_work.pending=false;
                behavior_queue_process_next(&queue_work.work);
            }
        } while (ret==-ENOMSG || ret==-EAGAIN);
        size_t completed=accepted_count;
        assert(queue_runtime_macro(items,ARRAY_SIZE(items),&(struct zmk_behavior_binding_event){.position=42},&state)==0);
        assert(completed==accepted_count);
        while (queue_work.pending || used) { queue_work.pending=false; behavior_queue_process_next(&queue_work.work); }
        const uint32_t waits[]={40,5,7,30,9,11,13,0};
        const uint32_t keys[]={0,A,0,B,B,A,0,RUNTIME_MACRO_COMPLETE_PARAM};
        const uint32_t params[]={0,UINT32_MAX,0,UINT32_MAX-1,UINT32_MAX-1,UINT32_MAX,0,0};
        const bool presses[]={true,true,true,true,false,false,true,true};
        assert(ret==0 && held==0 && invoked==4 && accepted_count==ARRAY_SIZE(waits));
        for (size_t i=0;i<accepted_count;i++) {
            assert(accepted[i].wait==waits[i] && accepted[i].binding.param1==keys[i]);
            assert(accepted[i].binding.param2==params[i] && accepted[i].press==presses[i]);
            assert(accepted[i].position==42);
            assert(strcmp(accepted[i].binding.behavior_dev,(i==1 || i==3 || i==4 || i==5)?"key_press":RUNTIME_MACRO_WAIT_BEHAVIOR_NAME)==0);
            printf("mixed action=%zu wait=%u param1=%u param2=%u pressed=%u\n",i,waits[i],keys[i],params[i],presses[i]);
        }
        assert(accepted_wait_ms==115);
    } else {
        bool nonpacked=strncmp(argv[1],"nonpacked-",10)==0;
        unsigned wait=atoi(argv[1]+(nonpacked?10:0));
        struct zmk_behavior_binding bindings[]={{.behavior_dev="key_press",.param1=A},{.behavior_dev="key_press",.param1=B}};
        if (nonpacked) {
            for(unsigned i=0;i<2;i++) { bindings[i].behavior_dev="other"; bindings[i].param1=0; }
        }
        struct runtime_macro_default_config cfg={.bindings=bindings,.bindings_len=2,.wait_ms=wait};
        uint8_t encoded[64];
        struct runtime_macro_encode_state s={.buf=encoded,.capacity=sizeof(encoded)};
        assert(emit_byte(&s,1)==0);
        assert(encode_bindings(&s,&cfg)==0 && flush_packed_sequence(&s)==0);
        printf("wait=%u, encoded:",wait);
        for(size_t i=0;i<s.size;i++) printf(" %u",encoded[i]);
        printf("\n");
        const uint8_t packed[]={1,5,2,4,5};
        const uint8_t waited[]={1,3,1,0,0,4,50,3,1,0,0};
        assert(nonpacked ? (s.size==sizeof(waited) && memcmp(encoded,waited,sizeof(waited))==0) : (s.size==sizeof(packed) && memcmp(encoded,packed,sizeof(packed))==0));
    }
    return 0;
}
"""


class PlaybackRegressions(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        retained = os.environ.get("RUNTIME_MACRO_REVIEW_OUTPUT")
        if retained:
            work = Path(retained)
            if not work.is_absolute() or work.exists() or work.is_symlink():
                raise ValueError("Use a fresh absolute RUNTIME_MACRO_REVIEW_OUTPUT")
            work.mkdir(parents=True)
        else:
            cls.temp = tempfile.TemporaryDirectory(prefix="macro-review-")
            cls.addClassCleanup(cls.temp.cleanup)
            work = Path(cls.temp.name)
        print(f"Playback review evidence: {work}", flush=True)
        source = ROOT / "src/runtime_macro.c"
        defaults = ROOT / "src/runtime_macro_dt_defaults.c"
        zmk = Path(os.environ["ZMK_ROOT"])
        core = zmk / "app/src/behavior_queue.c"
        unit = PREFIX + declaration(core, "struct", "q_item") + KERNEL_QUEUE
        unit += '#include "' + str(source.parent / "runtime_macro_codec.h") + '"\n'
        for name in ("behavior_queue_process_next", "zmk_behavior_queue_add"):
            unit += function(core, name)
        unit += declaration(source, "struct", "runtime_macro_queue_item")
        unit += declaration(source, "struct", "runtime_macro_queue_state")
        for name in (
            "zmk_runtime_macro_pack_key_tap",
            "queue_behavior",
            "add_saturating_delay",
            "queue_runtime_macro",
        ):
            unit += function(source, name)
        for kind, name in (
            ("struct", "runtime_macro_default_config"),
            ("enum", "runtime_macro_default_step_mode"),
            ("struct", "runtime_macro_encode_state"),
        ):
            unit += declaration(defaults, kind, name)
        for name in (
            "emit_byte",
            "emit_uvar",
            "flush_packed_sequence",
            "try_append_packed_tap",
            "emit_delay_step",
            "emit_binding_step",
            "name_matches",
            "encode_bindings",
        ):
            unit += function(defaults, name)
        path = work / "review.c"
        path.write_text(unit + SCENARIO)
        inputs = {
            str(p): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in (source, defaults, core)
        }
        print("Source identities:", inputs, flush=True)
        cls.binary = work / "review"
        command = [
            "cc",
            "-std=c11",
            "-O1",
            "-g",
            "-fsanitize=address,undefined",
            "-fno-sanitize-recover=all",
            "-I" + str(zmk / "app/include"),
            str(path),
            "-o",
            str(cls.binary),
        ]
        (work / "compile-inputs.json").write_text(
            json.dumps({"command": command, "source_sha256": inputs}, indent=2) + "\n"
        )
        with (work / "compile.log").open("x") as stream:
            subprocess.run(command, check=True, stdout=stream, stderr=subprocess.STDOUT)
        (work / "review.sha256").write_text(
            hashlib.sha256(cls.binary.read_bytes()).hexdigest() + "  review\n"
        )

    def case(self, name):
        result = subprocess.run(
            [str(self.binary), name],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        (self.binary.parent / f"run-{name}.log").write_text(result.stdout)
        (self.binary.parent / f"run-{name}.exit").write_text(
            str(result.returncode) + "\n"
        )
        print(name + f": exit={result.returncode}\n" + result.stdout, flush=True)
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_32_taps_control(self):
        self.case("queue-32")

    def test_33_taps_release_every_press(self):
        self.case("queue-33")

    def test_maximum_decoded_taps_release_every_press(self):
        self.case("queue-64")

    def test_mixed_actions_keep_exact_order_and_waits_under_pressure(self):
        self.case("mixed")

    def test_packed_sequence_without_wait_control(self):
        self.case("0")

    def test_packed_sequence_keeps_documented_wait_exemption(self):
        self.case("50")

    def test_nonpacked_bindings_preserve_wait(self):
        self.case("nonpacked-50")


if __name__ == "__main__":
    unittest.main()
