import { StrictMode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  createConnectedMockZMKApp,
  ZMKAppProvider,
} from "@cormoran/zmk-studio-react-hook/testing";
import { call_rpc } from "@zmkfirmware/zmk-studio-ts-client";
import { RuntimeMacroEditor, SUBSYSTEM_IDENTIFIER } from "../../web/src/App";
import {
  Request,
  Response,
  type MacroStep,
} from "../../web/src/proto/cormoran/runtime_macro/runtime_macro";

jest.mock("@zmkfirmware/zmk-studio-ts-client", () => ({ call_rpc: jest.fn() }));
type Macro = { slot: number; name: string; steps: MacroStep[] };
const initial = (): Macro[] => [
  {
    slot: 0,
    name: "Alpha",
    steps: [{ delay: { delayMs: 1 } }, { delay: { delayMs: 2 } }],
  },
  { slot: 1, name: "Beta", steps: [] },
  { slot: 2, name: "Gamma", steps: [] },
];
function reply(value: Parameters<typeof Response.create>[0]) {
  return {
    custom: {
      call: { payload: Response.encode(Response.create(value)).finish() },
    },
  };
}
function status() {
  return reply({ status: { affectedCount: 1, message: "OK" } });
}
function globalSettings() {
  return reply({
    getMacroGlobalSettings: {
      settings: {
        tapMs: 30,
        maxEntries: 8,
        keyPressBehaviorId: 1,
        poolBytesTotal: 1024,
        poolBytesUsed: 20,
      },
    },
  });
}
function body(macro: Macro) {
  return reply({ getMacro: { macro: { ...macro, encodedSize: 5 } } });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function app(subsystems = [SUBSYSTEM_IDENTIFIER, "fixture"]) {
  return createConnectedMockZMKApp({
    subsystems,
    deviceName: "Fixture Device",
  });
}
function panel(value: ReturnType<typeof app>, strict = false) {
  const element = (
    <ZMKAppProvider value={value}>
      <RuntimeMacroEditor />
    </ZMKAppProvider>
  );
  return strict ? <StrictMode>{element}</StrictMode> : element;
}
async function flush() {
  await act(async () => {
    for (let n = 0; n < 32; n++) await Promise.resolve();
  });
}
async function loaded() {
  await act(async () => {
    jest.advanceTimersByTime(0);
  });
  await flush();
}
function requests() {
  return (call_rpc as jest.Mock).mock.calls.map((call) => ({
    connection: call[0],
    index: call[1].custom.call.subsystemIndex,
    request: Request.decode(call[1].custom.call.payload),
  }));
}
function bodyWriteButton() {
  return screen.getAllByRole("button", { name: "Write Memory" }).at(-1)!;
}
function macroButton(name: string) {
  return screen.getByRole("button", { name: new RegExp(`^${name} slot`) });
}
function replacement(old: ReturnType<typeof app>, change: string) {
  const next = app(
    change === "index"
      ? ["fixture", SUBSYSTEM_IDENTIFIER]
      : change === "catalog"
        ? [SUBSYSTEM_IDENTIFIER, "replacement"]
        : undefined,
  );
  if (change !== "connection") next.state.connection = old.state.connection;
  return next;
}

describe("Runtime Macro session and editor ownership", () => {
  let macros: Macro[];
  let intercept: ((request: Request) => unknown) | undefined;
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    macros = initial();
    intercept = undefined;
    (call_rpc as jest.Mock).mockImplementation((_connection, raw) => {
      const request = Request.decode(raw.custom.call.payload);
      const blocked = intercept?.(request);
      if (blocked !== undefined) return blocked;
      if (request.listMacros)
        return Promise.resolve(
          reply({
            listMacros: {
              macros: macros.map((m) => ({
                slot: m.slot,
                name: m.name,
                encodedSize: 5,
              })),
              maxMacroBytes: 256,
              maxNameLength: 31,
            },
          }),
        );
      if (request.getMacroGlobalSettings)
        return Promise.resolve(globalSettings());
      if (request.getMacro)
        return Promise.resolve(
          body(macros.find((m) => m.slot === request.getMacro!.slot)!),
        );
      if (request.createMacro)
        macros.push({
          slot: macros.length,
          name: request.createMacro.name,
          steps: [],
        });
      if (request.renameMacro)
        macros.find((m) => m.name === request.renameMacro!.oldName)!.name =
          request.renameMacro.newName;
      return Promise.resolve(status());
    });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it.each(["connection", "index", "catalog"])(
    "starts a fresh editor and retires a pending create on %s replacement",
    async (change) => {
      const old = app();
      const view = render(panel(old));
      await loaded();
      expect(screen.getByDisplayValue("Alpha")).toBeInTheDocument();
      const pending = deferred<ReturnType<typeof status>>();
      intercept = (request) =>
        request.createMacro ? pending.promise : undefined;
      fireEvent.change(screen.getByPlaceholderText("New macro name"), {
        target: { value: "Retired" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
      await flush();
      expect(requests().filter((r) => r.request.createMacro)).toHaveLength(1);
      view.rerender(panel(replacement(old, change)));
      await loaded();
      expect(screen.getByPlaceholderText("New macro name")).toHaveValue("");
      expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
      const mark = requests().length;
      await act(async () => {
        pending.resolve(status());
      });
      await flush();
      expect(requests().slice(mark)).toHaveLength(0);
    },
  );

  it.each(["connection", "index", "catalog"])(
    "stops a partially dispatched step write after %s retirement",
    async (change) => {
      const old = app();
      const view = render(panel(old));
      await loaded();
      const pending = deferred<ReturnType<typeof status>>();
      intercept = (request) =>
        request.setMacroStepCount ? pending.promise : undefined;
      fireEvent.click(bodyWriteButton());
      await flush();
      expect(
        requests().filter((r) => r.request.setMacroStepCount),
      ).toHaveLength(1);
      view.rerender(panel(replacement(old, change)));
      await loaded();
      await act(async () => {
        pending.resolve(status());
      });
      await flush();
      expect(requests().filter((r) => r.request.setMacroStep)).toHaveLength(0);
    },
  );

  it("keeps the last selected macro when an earlier body reply arrives later", async () => {
    render(panel(app()));
    await loaded();
    const pending = deferred<ReturnType<typeof body>>();
    intercept = (request) =>
      request.getMacro?.slot === 1 ? pending.promise : undefined;
    fireEvent.click(macroButton("Beta"));
    await flush();
    fireEvent.click(macroButton("Gamma"));
    await flush();
    expect(screen.getByDisplayValue("Gamma")).toBeInTheDocument();
    await act(async () => {
      pending.resolve(body(macros[1]));
    });
    await flush();
    expect(screen.getByDisplayValue("Gamma")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Beta")).not.toBeInTheDocument();
    expect(bodyWriteButton()).toBeEnabled();
  });

  it("keeps a pending write busy when a different macro body finishes loading", async () => {
    render(panel(app()));
    await loaded();
    const pending = deferred<ReturnType<typeof status>>();
    intercept = (request) =>
      request.setMacroStepCount ? pending.promise : undefined;
    fireEvent.click(bodyWriteButton());
    await flush();
    fireEvent.click(macroButton("Beta"));
    await flush();
    expect(screen.getByDisplayValue("Beta")).toBeInTheDocument();
    expect(bodyWriteButton()).toBeDisabled();
    await act(async () => {
      pending.resolve(status());
    });
    await flush();
    expect(screen.getByDisplayValue("Beta")).toBeInTheDocument();
    expect(bodyWriteButton()).toBeEnabled();
  });

  it("does not let a pending refresh replace a newer user selection", async () => {
    render(panel(app()));
    await loaded();
    const pending = deferred<ReturnType<typeof globalSettings>>();
    intercept = (request) =>
      request.getMacroGlobalSettings ? pending.promise : undefined;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await flush();
    fireEvent.click(macroButton("Beta"));
    await flush();
    expect(screen.getByDisplayValue("Beta")).toBeInTheDocument();
    await act(async () => {
      pending.resolve(globalSettings());
    });
    await flush();
    expect(screen.getByDisplayValue("Beta")).toBeInTheDocument();
  });

  it("selects the newly created macro instead of the stale previous selection", async () => {
    render(panel(app()));
    await loaded();
    fireEvent.change(screen.getByPlaceholderText("New macro name"), {
      target: { value: "Created" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await flush();
    expect(screen.getByDisplayValue("Created")).toBeInTheDocument();
  });

  it("keeps a renamed non-first macro selected", async () => {
    render(panel(app()));
    await loaded();
    fireEvent.click(macroButton("Beta"));
    await flush();
    fireEvent.change(screen.getByDisplayValue("Beta"), {
      target: { value: "Renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await flush();
    expect(screen.getByDisplayValue("Renamed")).toBeInTheDocument();
  });

  it("disposes owned pending request timers immediately on unmount", async () => {
    (call_rpc as jest.Mock).mockReturnValue(new Promise(() => {}));
    const view = render(panel(app()));
    await loaded();
    expect(requests()).toHaveLength(1);
    view.unmount();
    await flush();
    jest.runAllTicks();
    expect(jest.getTimerCount()).toBe(0);
  });

  it("bounds an unresolved request and restores the current editor controls", async () => {
    (call_rpc as jest.Mock).mockReturnValue(new Promise(() => {}));
    render(panel(app()));
    await loaded();
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    await flush();
    expect(screen.getByText(/timed out/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
  });

  it("preserves current-session forms across an unrelated provider update", async () => {
    const current = app();
    const view = render(panel(current));
    await loaded();
    fireEvent.change(screen.getByPlaceholderText("New macro name"), {
      target: { value: "Current" },
    });
    const count = requests().length;
    view.rerender(panel({ ...current }));
    await loaded();
    expect(screen.getByPlaceholderText("New macro name")).toHaveValue(
      "Current",
    );
    expect(requests()).toHaveLength(count);
  });

  it("keeps StrictMode cleanup replay from duplicating initial refresh", async () => {
    render(panel(app(), true));
    await loaded();
    expect(screen.getByDisplayValue("Alpha")).toBeInTheDocument();
    expect(requests().filter((r) => r.request.listMacros)).toHaveLength(1);
  });
  it.each([
    { kind: "delay", label: "Delay ms", value: "0.5", valid: "1" },
    { kind: "delay", label: "Delay ms", value: "4294967296", valid: "1" },
    { kind: "delay", label: "Delay ms", value: "60001", valid: "1" },
    { kind: "tap", label: "Param 1", value: "4294967296", valid: "1" },
    { kind: "tap", label: "Behavior ID", value: "4294967296", valid: "1" },
    { kind: "sequence", label: "Packed keys", value: "00", valid: "04" },
  ])(
    "keeps invalid $label=$value editable without sending a partial write",
    async ({ kind, label, value, valid }) => {
      macros[0].steps =
        kind === "delay"
          ? [{ delay: { delayMs: 1 } }]
          : kind === "tap"
            ? [{ tap: { behaviorId: 7, param1: 0, param2: 0 } }]
            : [{ keyTapSequence: { packedKeys: Uint8Array.from([4]) } }];
      render(panel(app()));
      await loaded();
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
      await flush();
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(screen.getByPlaceholderText("New macro name")).toBeInTheDocument();
      expect(bodyWriteButton()).toBeDisabled();
      fireEvent.click(bodyWriteButton());
      await flush();
      expect(
        requests().filter((r) => r.request.setMacroStepCount),
      ).toHaveLength(0);
      fireEvent.change(screen.getByLabelText(label), {
        target: { value: valid },
      });
      await flush();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(bodyWriteButton()).toBeEnabled();
    },
  );
  it.each(["0.5", "10001"])(
    "refuses invalid tap duration %s before dispatch",
    async (value) => {
      render(panel(app()));
      await loaded();
      fireEvent.change(screen.getByLabelText("Tap ms"), { target: { value } });
      fireEvent.click(
        screen.getAllByRole("button", { name: "Write Memory" })[0],
      );
      await flush();
      expect(requests().filter((r) => r.request.setTapMs)).toHaveLength(0);
      expect(
        screen.getByText(/Tap ms must be an integer|invalid uint32/i),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
    },
  );
  it.each([
    "reject-error",
    "throw-error",
    "reject-undefined",
    "reject-null",
    "reject-false",
    "throw-undefined",
  ])(
    "clears the request deadline and restores controls after %s",
    async (failure) => {
      render(panel(app()));
      await loaded();
      const named = failure.endsWith("error");
      const error = named
        ? new Error("Fixture transport failure")
        : failure.endsWith("null")
          ? null
          : failure.endsWith("false")
            ? false
            : undefined;
      intercept = (request) => {
        if (request.getMacro?.slot !== 1) return undefined;
        if (failure.startsWith("throw")) throw error;
        return Promise.reject(error);
      };
      fireEvent.click(macroButton("Beta"));
      await flush();
      expect(
        screen.getByText(
          named ? "Fixture transport failure" : "Failed to load macro",
        ),
      ).toBeInTheDocument();
      expect(screen.getByDisplayValue("Alpha")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
      jest.runAllTicks();
      expect(jest.getTimerCount()).toBe(0);
    },
  );
});
