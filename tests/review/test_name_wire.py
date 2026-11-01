"""Real nanopb name bounds must include 32 content bytes plus their NUL."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]

C_SOURCE = r"""
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pb_encode.h>
#include <pb_decode.h>
#include "runtime_macro.pb.h"
#define CHECK(message, field) do { \
    cormoran_runtime_macro_##message value=cormoran_runtime_macro_##message##_init_zero; \
    wire[0]=(cormoran_runtime_macro_##message##_##field##_tag<<3)|2; \
    pb_istream_t in=pb_istream_from_buffer(wire,n+2); \
    bool ok=pb_decode(&in,cormoran_runtime_macro_##message##_fields,&value); \
    printf(#message "." #field ": n=%u decode=%d error=%s\n",n,ok,ok?"":PB_GET_ERROR(&in)); \
    if(n>32) { assert(!ok); } else { \
        assert(ok && strlen(value.field)==n); \
        uint8_t roundtrip[96]; \
        pb_ostream_t out=pb_ostream_from_buffer(roundtrip,sizeof(roundtrip)); \
        assert(pb_encode(&out,cormoran_runtime_macro_##message##_fields,&value)); \
        assert(out.bytes_written==n+2 && memcmp(wire,roundtrip,n+2)==0); \
    } \
} while(0)
int main(int argc,char **argv) {
    assert(argc==2); setbuf(stdout,NULL);
    unsigned n=atoi(argv[1]); assert(n<=33);
    uint8_t wire[96]={0}; wire[1]=n; memset(wire+2,'A',n);
    CHECK(CreateMacroRequest,name);
    CHECK(DeleteMacroRequest,name);
    CHECK(RenameMacroRequest,old_name);
    CHECK(RenameMacroRequest,new_name);
    CHECK(MacroSummary,name);
    CHECK(MacroDetail,name);
    return 0;
}
"""


class MacroNameWire(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="macro-name-wire-")
        cls.addClassCleanup(cls.temp.cleanup)
        work = Path(cls.temp.name)
        nanopb = work / "nanopb"
        shutil.copytree(
            os.environ["NANOPB_ROOT"],
            nanopb,
            ignore=shutil.ignore_patterns(".git", "__pycache__"),
        )
        generated = work / "generated"
        generated.mkdir()
        subprocess.run(
            [
                "python3",
                str(nanopb / "generator/nanopb_generator.py"),
                "-D",
                str(generated),
                "-I",
                str(ROOT / "proto"),
                str(ROOT / "proto/cormoran/runtime_macro/runtime_macro.proto"),
            ],
            check=True,
        )
        (header,) = generated.rglob("runtime_macro.pb.h")
        (descriptor,) = generated.rglob("runtime_macro.pb.c")
        source = work / "review.c"
        source.write_text(C_SOURCE)
        cls.binary = work / "review"
        subprocess.run(
            [
                "cc",
                "-std=c11",
                "-O1",
                "-g",
                "-fsanitize=address,undefined",
                "-fno-sanitize-recover=all",
                "-DPB_WITHOUT_64BIT=1",
                "-I" + str(nanopb),
                "-I" + str(generated),
                "-I" + str(header.parent),
                str(source),
                str(descriptor),
                str(nanopb / "pb_common.c"),
                str(nanopb / "pb_encode.c"),
                str(nanopb / "pb_decode.c"),
                "-o",
                str(cls.binary),
            ],
            check=True,
        )

    def case(self, n):
        result = subprocess.run(
            [str(self.binary), str(n)],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        print(result.stdout, flush=True)
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_31_byte_name_control(self):
        self.case(31)

    def test_maximum_32_byte_names_round_trip(self):
        self.case(32)

    def test_33_byte_names_are_rejected(self):
        self.case(33)


if __name__ == "__main__":
    unittest.main()
