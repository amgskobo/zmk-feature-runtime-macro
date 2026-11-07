import { StrictMode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  createConnectedMockZMKApp,
  ZMKAppProvider,
} from "@cormoran/zmk-studio-react-hook/testing";
import { call_rpc } from "@zmkfirmware/zmk-studio-ts-client";
import { LockState } from "@zmkfirmware/zmk-studio-ts-client/core";
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
function unknownReply() {
  return {
    custom: {
      call: { payload: Uint8Array.from([0x98, 0x06, 0x01]) },
    },
  };
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
function notifyLock(value: ReturnType<typeof app>, state: LockState) {
  for (const [subscription] of (value.onNotification as jest.Mock).mock.calls) {
    if (subscription.type === "core") {
      subscription.callback({ lockStateChanged: state });
    }
  }
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

  it.each(["empty", "unknown", "wrong-operation"])(
    "keeps the catalog and draft after a settled %s catalog response",
    async (kind) => {
      render(panel(app()));
      await loaded();
      fireEvent.change(screen.getAllByLabelText("Delay ms")[0], {
        target: { value: "9" },
      });
      const invalid =
        kind === "empty"
          ? reply({})
          : kind === "unknown"
            ? unknownReply()
            : status();
      intercept = (request) =>
        request.listMacros ? Promise.resolve(invalid) : undefined;
      const mark = requests().length;
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
      await flush();
      expect(macroButton("Alpha")).toHaveClass("selected");
      expect(macroButton("Beta")).toBeInTheDocument();
      expect(macroButton("Gamma")).toBeInTheDocument();
      expect(screen.getAllByLabelText("Delay ms")[0]).toHaveValue(9);
      expect(requests().slice(mark)).toHaveLength(1);
      expect(
        screen.getByText("Unexpected Runtime Macro RPC response"),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
      intercept = undefined;
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
      await flush();
      expect(macroButton("Alpha")).toHaveClass("selected");
      expect(screen.getAllByLabelText("Delay ms")[0]).toHaveValue(9);
    },
  );

  it("keeps global metadata when its response omits the required settings", async () => {
    intercept = (request) =>
      request.getMacroGlobalSettings
        ? Promise.resolve(
            reply({
              getMacroGlobalSettings: {
                settings: {
                  tapMs: 73,
                  maxEntries: 8,
                  keyPressBehaviorId: 1,
                  poolBytesTotal: 640,
                  poolBytesUsed: 11,
                },
              },
            }),
          )
        : undefined;
    render(panel(app()));
    await loaded();
    expect(screen.getByLabelText("Tap ms")).toHaveValue(73);
    expect(screen.getByText(/11\/640 B used/)).toBeInTheDocument();
    intercept = (request) =>
      request.getMacroGlobalSettings
        ? Promise.resolve(reply({ getMacroGlobalSettings: {} }))
        : undefined;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await flush();
    expect(screen.getByLabelText("Tap ms")).toHaveValue(73);
    expect(screen.getByText(/11\/640 B used/)).toBeInTheDocument();
    expect(macroButton("Alpha")).toHaveClass("selected");
    expect(
      screen.getByText("Unexpected Runtime Macro RPC response"),
    ).toBeInTheDocument();
  });

  it.each(["empty", "unknown", "wrong-operation", "ambiguous"])(
    "does not accept a %s response as rename success",
    async (kind) => {
      render(panel(app()));
      await loaded();
      fireEvent.click(macroButton("Beta"));
      await flush();
      fireEvent.change(screen.getByLabelText("Name (slot 1)"), {
        target: { value: "Renamed" },
      });
      const invalid =
        kind === "empty"
          ? reply({})
          : kind === "unknown"
            ? unknownReply()
            : kind === "wrong-operation"
              ? globalSettings()
              : reply({
                  status: { affectedCount: 1, message: "OK" },
                  listMacros: { macros: [] },
                });
      intercept = (request) =>
        request.renameMacro ? Promise.resolve(invalid) : undefined;
      const mark = requests().length;
      fireEvent.click(screen.getByRole("button", { name: "Rename" }));
      await flush();
      expect(macroButton("Beta")).toHaveClass("selected");
      expect(screen.getByLabelText("Name (slot 1)")).toHaveValue("Renamed");
      expect(requests().slice(mark)).toHaveLength(1);
      expect(
        screen.queryByText('Renamed to "Renamed"'),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText("Unexpected Runtime Macro RPC response"),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Rename" })).toBeEnabled();
      intercept = undefined;
      fireEvent.click(screen.getByRole("button", { name: "Rename" }));
      await flush();
      expect(macroButton("Renamed")).toHaveClass("selected");
    },
  );

  it.each(["", "   "])(
    "shows a nonempty failure for an RPC error message %j",
    async (message) => {
      render(panel(app()));
      await loaded();
      intercept = (request) =>
        request.setTapMs
          ? Promise.resolve(reply({ error: { message } }))
          : undefined;
      fireEvent.click(
        screen.getAllByRole("button", { name: "Write Memory" })[0],
      );
      await flush();
      expect(
        screen.getByText("Runtime Macro RPC request failed"),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
      intercept = undefined;
      fireEvent.click(
        screen.getAllByRole("button", { name: "Write Memory" })[0],
      );
      await flush();
      expect(screen.getByText("Updated tap_ms in memory")).toBeInTheDocument();
    },
  );

  it("accepts a valid empty catalog and creates its first macro", async () => {
    macros = [];
    render(panel(app()));
    await loaded();
    expect(
      screen.queryByText("Unexpected Runtime Macro RPC response"),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("New macro name"), {
      target: { value: "Fresh" },
    });
    intercept = (request) => {
      if (!request.createMacro) return undefined;
      macros.push({ slot: 0, name: request.createMacro.name, steps: [] });
      // A present status submessage is valid even with no fields set.
      return Promise.resolve(reply({ status: {} }));
    };
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await flush();
    expect(macroButton("Fresh")).toHaveClass("selected");
    expect(screen.getByLabelText("Name (slot 0)")).toHaveValue("Fresh");
  });

  it("retires a delayed body read and clears protected editor state on lock", async () => {
    const current = app();
    render(panel(current));
    await loaded();
    const pending = deferred<ReturnType<typeof body>>();
    intercept = (request) =>
      request.getMacro?.slot === 1 ? pending.promise : undefined;
    fireEvent.click(macroButton("Beta"));
    await flush();
    act(() => notifyLock(current, LockState.ZMK_STUDIO_CORE_LOCK_STATE_LOCKED));
    await flush();
    expect(screen.getByText(/Studio is locked/i)).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Alpha")).not.toBeInTheDocument();
    expect(screen.queryAllByLabelText("Delay ms")).toHaveLength(0);
    // Modern Jest counts React act's fake microtasks alongside real deadlines.
    // Drain only those jobs; this does not advance or clear any timeout.
    jest.runAllTicks();
    expect(jest.getTimerCount()).toBe(0);
    const mark = requests().length;
    await act(async () => pending.resolve(body(macros[1])));
    await flush();
    expect(requests().slice(mark)).toHaveLength(0);
    expect(screen.queryByDisplayValue("Beta")).not.toBeInTheDocument();
    jest.runAllTicks();
    expect(jest.getTimerCount()).toBe(0);
    intercept = undefined;
    act(() =>
      notifyLock(current, LockState.ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED),
    );
    await loaded();
    expect(screen.getByDisplayValue("Alpha")).toBeInTheDocument();
    expect(bodyWriteButton()).toBeEnabled();
  });

  it("does not resume an old body write across a batched lock and unlock", async () => {
    const current = app();
    render(panel(current));
    await loaded();
    const pending = deferred<ReturnType<typeof status>>();
    intercept = (request) =>
      request.setMacroStepCount ? pending.promise : undefined;
    fireEvent.click(bodyWriteButton());
    await flush();
    expect(requests().filter((r) => r.request.setMacroStepCount)).toHaveLength(
      1,
    );
    jest.runAllTicks();
    expect(jest.getTimerCount()).toBe(1);
    act(() => {
      notifyLock(current, LockState.ZMK_STUDIO_CORE_LOCK_STATE_LOCKED);
      notifyLock(current, LockState.ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED);
    });
    await loaded();
    await act(async () => pending.resolve(status()));
    await flush();
    expect(requests().filter((r) => r.request.setMacroStepCount)).toHaveLength(
      1,
    );
    expect(requests().filter((r) => r.request.setMacroStep)).toHaveLength(0);
    expect(requests().filter((r) => r.request.appendMacroStep)).toHaveLength(0);
    expect(bodyWriteButton()).toBeEnabled();
    jest.runAllTicks();
    expect(jest.getTimerCount()).toBe(0);
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
      expect(requests().filter((r) => r.request.appendMacroStep)).toHaveLength(
        0,
      );
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

  it("keeps a later macro selection and draft when an earlier Create finishes", async () => {
    render(panel(app()));
    await loaded();
    const pending = deferred<ReturnType<typeof status>>();
    intercept = (request) =>
      request.createMacro
        ? pending.promise.then(() => {
            macros.push({
              slot: macros.length,
              name: request.createMacro!.name,
              steps: [],
            });
            return status();
          })
        : undefined;
    fireEvent.change(screen.getByPlaceholderText("New macro name"), {
      target: { value: "Created" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await flush();
    fireEvent.click(macroButton("Beta"));
    await flush();
    expect(screen.getByDisplayValue("Beta")).toBeInTheDocument();
    const json = document.querySelector("textarea")!;
    fireEvent.change(json, { target: { value: "[newer Beta draft" } });
    await act(async () => pending.resolve(status()));
    await flush();
    expect(macros.some((macro) => macro.name === "Created")).toBe(true);
    expect(screen.getByDisplayValue("Beta")).toBeInTheDocument();
    expect(json).toHaveValue("[newer Beta draft");
    expect(bodyWriteButton()).toBeEnabled();
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

  it("keeps an unsubmitted body and JSON draft across rename and refresh", async () => {
    render(panel(app()));
    await loaded();
    fireEvent.change(screen.getAllByLabelText("Delay ms")[0], {
      target: { value: "99" },
    });
    const json = document.querySelector("textarea")!;
    fireEvent.change(json, { target: { value: "[unfinished draft" } });
    fireEvent.change(screen.getByDisplayValue("Alpha"), {
      target: { value: "Renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await flush();
    expect(screen.getByDisplayValue("Renamed")).toBeInTheDocument();
    expect(screen.getAllByLabelText("Delay ms")[0]).toHaveValue(99);
    expect(json).toHaveValue("[unfinished draft");
    expect(macros[0].steps[0].delay?.delayMs).toBe(1);
    expect(
      requests().filter(
        (r) =>
          r.request.setMacroStepCount ||
          r.request.setMacroStep ||
          r.request.appendMacroStep,
      ),
    ).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await flush();
    expect(screen.getAllByLabelText("Delay ms")[0]).toHaveValue(99);
    expect(json).toHaveValue("[unfinished draft");
  });

  it("keeps the next name draft when an earlier Rename finishes", async () => {
    render(panel(app()));
    await loaded();
    const pending = deferred<ReturnType<typeof status>>();
    intercept = (request) =>
      request.renameMacro
        ? pending.promise.then(() => {
            macros.find(
              (macro) => macro.name === request.renameMacro!.oldName,
            )!.name = request.renameMacro!.newName;
            return status();
          })
        : undefined;
    const name = screen.getByDisplayValue("Alpha");
    fireEvent.change(name, { target: { value: "First rename" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await flush();
    expect(name).toBeEnabled();
    fireEvent.change(name, { target: { value: "Next rename draft" } });
    await act(async () => pending.resolve(status()));
    await flush();
    expect(macros[0].name).toBe("First rename");
    expect(name).toHaveValue("Next rename draft");
    expect(screen.getByRole("button", { name: "Rename" })).toBeEnabled();
    expect(requests().filter((r) => r.request.renameMacro)).toHaveLength(1);
  });

  it("keeps the next creation name while a prior Create completes", async () => {
    render(panel(app()));
    await loaded();
    const pending = deferred<ReturnType<typeof status>>();
    intercept = (request) =>
      request.createMacro
        ? pending.promise.then(() => {
            macros.push({
              slot: macros.length,
              name: request.createMacro!.name,
              steps: [],
            });
            return status();
          })
        : undefined;
    const name = screen.getByPlaceholderText("New macro name");
    fireEvent.change(name, { target: { value: "First creation" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await flush();
    fireEvent.change(name, { target: { value: "Next creation draft" } });
    await act(async () => pending.resolve(status()));
    await flush();
    expect(macros.some((macro) => macro.name === "First creation")).toBe(true);
    expect(name).toHaveValue("Next creation draft");
    expect(screen.getByRole("button", { name: "Create" })).toBeEnabled();
  });

  it("keeps an unsubmitted tap setting when another action refreshes metadata", async () => {
    render(panel(app()));
    await loaded();
    fireEvent.change(screen.getByLabelText("Tap ms"), {
      target: { value: "75" },
    });
    fireEvent.change(screen.getByDisplayValue("Alpha"), {
      target: { value: "Renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await flush();
    expect(screen.getByDisplayValue("Renamed")).toBeInTheDocument();
    expect(screen.getByLabelText("Tap ms")).toHaveValue(75);
    expect(requests().filter((r) => r.request.setTapMs)).toHaveLength(0);
  });

  it("keeps a tap setting edited while its metadata read is pending", async () => {
    render(panel(app()));
    await loaded();
    const pending = deferred<ReturnType<typeof globalSettings>>();
    intercept = (request) =>
      request.getMacroGlobalSettings ? pending.promise : undefined;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await flush();
    fireEvent.change(screen.getByLabelText("Tap ms"), {
      target: { value: "75" },
    });
    await act(async () => pending.resolve(globalSettings()));
    await flush();
    expect(screen.getByLabelText("Tap ms")).toHaveValue(75);
  });

  it("keeps a newer tap draft after saving an older value and refreshing", async () => {
    render(panel(app()));
    await loaded();
    let storedTapMs = 30;
    const pending = deferred<ReturnType<typeof status>>();
    intercept = (request) => {
      if (request.getMacroGlobalSettings)
        return Promise.resolve(
          reply({
            getMacroGlobalSettings: {
              settings: { tapMs: storedTapMs, keyPressBehaviorId: 1 },
            },
          }),
        );
      if (request.setTapMs)
        return pending.promise.then(() => {
          storedTapMs = request.setTapMs!.tapMs;
          return status();
        });
      return undefined;
    };
    fireEvent.change(screen.getByLabelText("Tap ms"), {
      target: { value: "50" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);
    await flush();
    fireEvent.change(screen.getByLabelText("Tap ms"), {
      target: { value: "75" },
    });
    await act(async () => pending.resolve(status()));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await flush();
    expect(storedTapMs).toBe(50);
    expect(screen.getByLabelText("Tap ms")).toHaveValue(75);
  });

  it("keeps newer edits when an earlier body write finishes", async () => {
    render(panel(app()));
    await loaded();
    const pending = deferred<ReturnType<typeof status>>();
    intercept = (request) => {
      if (request.setMacroStepCount)
        return pending.promise.then(() => {
          macros[0].steps =
            request.setMacroStepCount!.stepCount === 0 ? [] : macros[0].steps;
          return status();
        });
      if (request.appendMacroStep)
        macros[0].steps.push(request.appendMacroStep.step!);
      if (request.setMacroStep)
        macros[0].steps[request.setMacroStep.stepIndex] =
          request.setMacroStep.step!;
      return undefined;
    };
    fireEvent.change(screen.getAllByLabelText("Delay ms")[0], {
      target: { value: "50" },
    });
    fireEvent.click(bodyWriteButton());
    await flush();
    expect(bodyWriteButton()).toBeDisabled();
    fireEvent.change(screen.getAllByLabelText("Delay ms")[0], {
      target: { value: "99" },
    });
    const json = document.querySelector("textarea")!;
    fireEvent.change(json, { target: { value: "[newer JSON draft" } });
    await act(async () => pending.resolve(status()));
    await flush();
    expect(bodyWriteButton()).toBeEnabled();
    expect(macros[0].steps[0].delay?.delayMs).toBe(50);
    expect(screen.getAllByLabelText("Delay ms")[0]).toHaveValue(99);
    expect(json).toHaveValue("[newer JSON draft");
  });

  it("preserves a body edit made while its refreshed read is pending", async () => {
    render(panel(app()));
    await loaded();
    const pending = deferred<ReturnType<typeof body>>();
    intercept = (request) =>
      request.getMacro?.slot === 0 ? pending.promise : undefined;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await flush();
    fireEvent.change(screen.getAllByLabelText("Delay ms")[0], {
      target: { value: "99" },
    });
    await act(async () => pending.resolve(body(macros[0])));
    await flush();
    expect(screen.getAllByLabelText("Delay ms")[0]).toHaveValue(99);
  });

  it.each([false, true])(
    "persists only a completed full rewrite (persist=%s)",
    async (persist) => {
      render(panel(app()));
      await loaded();
      fireEvent.click(
        persist
          ? screen.getAllByRole("button", { name: "Save" }).at(-1)!
          : bodyWriteButton(),
      );
      await flush();
      const writes = requests()
        .map((r) => r.request)
        .filter((r) => r.setMacroStepCount || r.appendMacroStep);
      expect(writes).toHaveLength(3);
      expect(writes[0].setMacroStepCount).toMatchObject({
        slot: 0,
        stepCount: 0,
        persist: false,
      });
      expect(writes[1].appendMacroStep).toMatchObject({
        slot: 0,
        step: { delay: { delayMs: 1 } },
        persist: false,
      });
      expect(writes[2].appendMacroStep).toMatchObject({
        slot: 0,
        step: { delay: { delayMs: 2 } },
        persist,
      });
    },
  );

  it("persists an empty body when Save has no steps to append", async () => {
    render(panel(app()));
    await loaded();
    fireEvent.click(macroButton("Beta"));
    await flush();
    fireEvent.click(screen.getAllByRole("button", { name: "Save" }).at(-1)!);
    await flush();
    const writes = requests()
      .map((r) => r.request)
      .filter((r) => r.setMacroStepCount || r.appendMacroStep);
    expect(writes).toHaveLength(1);
    expect(writes[0].setMacroStepCount).toMatchObject({
      slot: 1,
      stepCount: 0,
      persist: true,
    });
  });

  it("rewrites a valid full body without retaining capacity-consuming old steps", async () => {
    const keys = { keyTapSequence: { packedKeys: new Uint8Array(63).fill(4) } };
    macros[0].steps = [{ delay: { delayMs: 0 } }, keys];
    const wanted = [keys, { delay: { delayMs: 0 } }];
    intercept = (request) => {
      const edit =
        request.setMacroStepCount ??
        request.setMacroStep ??
        request.appendMacroStep;
      if (!edit) return undefined;
      const macro = macros.find((m) => m.slot === edit.slot)!;
      let steps = [...macro.steps];
      if (request.setMacroStepCount) {
        const count = request.setMacroStepCount.stepCount;
        steps = steps.slice(0, count);
        while (steps.length < count) steps.push({ delay: { delayMs: 0 } });
      }
      if (request.setMacroStep)
        steps[request.setMacroStep.stepIndex] = request.setMacroStep.step!;
      if (request.appendMacroStep) steps.push(request.appendMacroStep.step!);
      // Independent action-budget oracle, including empty packed sequences.
      const actions = steps.reduce(
        (count, step) => count + (step.keyTapSequence?.packedKeys.length ?? 1),
        0,
      );
      if (actions > 64)
        return Promise.resolve(
          reply({ error: { message: "Action capacity exceeded" } }),
        );
      macro.steps = steps;
      return Promise.resolve(status());
    };
    render(panel(app()));
    await loaded();
    const json = document.querySelector("textarea")!;
    fireEvent.change(json, {
      target: {
        value: JSON.stringify([
          ...Array.from({ length: 63 }, () => ({
            action: "tap",
            binding: { type: "raw", zmk: "local-id:1 458756 0" },
          })),
          { action: "delay", delayTime: 0 },
        ]),
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await flush();
    fireEvent.click(bodyWriteButton());
    await flush();
    expect(macros[0].steps).toEqual(wanted);
    expect(
      screen.queryByText("Action capacity exceeded"),
    ).not.toBeInTheDocument();
    const writes = requests().filter(
      (r) => r.request.setMacroStepCount || r.request.appendMacroStep,
    );
    expect(writes[0].request.setMacroStepCount?.stepCount).toBe(0);
    expect(
      writes.slice(1).every((r) => Boolean(r.request.appendMacroStep)),
    ).toBe(true);
    expect(bodyWriteButton()).toBeEnabled();
  });

  it("disposes owned pending request timers immediately on unmount", async () => {
    (call_rpc as jest.Mock).mockReturnValue(new Promise(() => {}));
    const view = render(panel(app()));
    await loaded();
    expect(requests()).toHaveLength(1);
    const before = Date.now();
    let microtaskRan = false;
    queueMicrotask(() => {
      microtaskRan = true;
    });
    jest.runAllTicks();
    expect(microtaskRan).toBe(true);
    expect(Date.now()).toBe(before);
    // A genuinely outstanding RPC still owns its 5s deadline after the drain.
    expect(jest.getTimerCount()).toBe(1);
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
