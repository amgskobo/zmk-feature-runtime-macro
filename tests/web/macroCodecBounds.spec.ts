import { decodeRuntimeMacro } from "../../web/src/macroCodec";
describe("Runtime Macro uint32 varuint bounds", () => {
  it.each([
    ["delay", [1, 4, 0x80, 0x80, 0x80, 0x80, 0x10]],
    ["binding", [1, 3, 0x80, 0x80, 0x80, 0x80, 0x10, 0, 0]],
    ["sequence length", [1, 5, 0x80, 0x80, 0x80, 0x80, 0x10]],
  ])("rejects an overflowing fifth byte for %s", (_name, bytes) => {
    expect(() =>
      decodeRuntimeMacro(Uint8Array.from(bytes as number[])),
    ).toThrow(/varuint/i);
  });
  it("retains full-width uint32 decoding independently of editor delay limits", () => {
    expect(
      decodeRuntimeMacro(Uint8Array.from([1, 4, 0xff, 0xff, 0xff, 0xff, 0x0f])),
    ).toEqual([{ action: "delay", delayMs: 0xffffffff }]);
  });
  it("preserves a non-overflowing extended zero representation accepted by firmware", () => {
    expect(
      decodeRuntimeMacro(Uint8Array.from([1, 4, 0x80, 0x80, 0x80, 0x80, 0])),
    ).toEqual([{ action: "delay", delayMs: 0 }]);
  });
});
