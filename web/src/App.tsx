import { useCallback, useContext, useEffect, useRef, useState } from "react";
import "./App.css";
import { useSessionRpc, isRetiredRequest } from "./useSessionRpc";
import { connect as serialConnect } from "@zmkfirmware/zmk-studio-ts-client/transport/serial";
import { ZMKConnection, ZMKAppContext } from "@cormoran/zmk-studio-react-hook";
import {
  Request,
  Response,
} from "./proto/cormoran/runtime_macro/runtime_macro";
import {
  compactKeyTapSteps,
  encodeRuntimeMacro,
  fromKeyboardAbyssSteps,
  toKeyboardAbyssSteps,
} from "./macroCodec";
import type { RuntimeMacroStep } from "./macroCodec";
import type { MacroStep as RpcMacroStep } from "./proto/cormoran/runtime_macro/runtime_macro";

export const SUBSYSTEM_IDENTIFIER = "cormoran__runtime_macro";

type MacroSummary = {
  slot: number;
  name: string;
  encodedSize: number;
  hasUnsavedChanges: boolean;
};

type LoadedMacro = {
  slot: number;
  name: string;
  steps: RuntimeMacroStep[];
};

const MAX_DELAY_MS = 60000;
const MAX_TAP_MS = 10000;

const DEFAULT_STEP: RuntimeMacroStep = {
  action: "tap",
  behaviorId: 0,
  param1: 0,
  param2: 0,
};

function runtimeStepToRpc(step: RuntimeMacroStep): RpcMacroStep {
  if (step.action === "delay") {
    return { delay: { delayMs: step.delayMs } };
  }
  if (step.action === "keySequence") {
    return { keyTapSequence: { packedKeys: Uint8Array.from(step.packedKeys) } };
  }

  const binding = {
    behaviorId: step.behaviorId,
    param1: step.param1,
    param2: step.param2,
  };

  if (step.action === "down") return { down: binding };
  if (step.action === "up") return { up: binding };
  return { tap: binding };
}

function runtimeStepFromRpc(step: RpcMacroStep): RuntimeMacroStep {
  if (step.down) return { action: "down", ...step.down };
  if (step.up) return { action: "up", ...step.up };
  if (step.tap) return { action: "tap", ...step.tap };
  if (step.delay) return { action: "delay", delayMs: step.delay.delayMs };
  if (step.keyTapSequence) {
    return {
      action: "keySequence",
      packedKeys: [...step.keyTapSequence.packedKeys],
    };
  }

  throw new Error("Macro step is missing oneof data");
}

function App() {
  return (
    <div className="app">
      <header className="app-header">
        <h1>Runtime Macro</h1>
        <p>
          Edit compact, runtime-configurable ZMK macros over custom Studio RPC.
        </p>
      </header>

      <ZMKConnection
        renderDisconnected={({ connect, isLoading, error }) => (
          <section className="panel">
            <h2>Device</h2>
            {isLoading && <p>Connecting...</p>}
            {error && <p className="message error">{error}</p>}
            {!isLoading && (
              <button
                className="btn primary"
                onClick={() => connect(serialConnect)}
              >
                Connect Serial
              </button>
            )}
          </section>
        )}
        renderConnected={({ disconnect, deviceName }) => (
          <>
            <section className="panel device-row">
              <div>
                <h2>Device</h2>
                <p>{deviceName}</p>
              </div>
              <button className="btn" onClick={disconnect}>
                Disconnect
              </button>
            </section>
            <RuntimeMacroEditor />
          </>
        )}
      />
    </div>
  );
}

const connectionIds = new WeakMap<object, number>();
let nextConnectionId = 1;
function sessionKey(
  connection: object | null | undefined,
  index: number | undefined,
  catalog: string
) {
  let identity = 0;
  if (connection) {
    identity = connectionIds.get(connection) ?? nextConnectionId++;
    connectionIds.set(connection, identity);
  }
  return `${identity}:${index ?? "missing"}:${catalog}`;
}
export function RuntimeMacroEditor() {
  const app = useContext(ZMKAppContext);
  const connection = app?.state.connection;
  const index = app?.findSubsystem(SUBSYSTEM_IDENTIFIER)?.index;
  const catalog = JSON.stringify(app?.state.customSubsystems?.subsystems ?? []);
  return <RuntimeMacroSession key={sessionKey(connection, index, catalog)} />;
}
function RuntimeMacroSession() {
  const zmkApp = useContext(ZMKAppContext);
  const [macros, setMacros] = useState<MacroSummary[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [loadedMacro, setLoadedMacro] = useState<LoadedMacro | null>(null);
  const [maxMacroBytes, setMaxMacroBytes] = useState(64);
  const [maxNameLength, setMaxNameLength] = useState(32);
  const [poolBytesTotal, setPoolBytesTotal] = useState(0);
  const [poolBytesUsed, setPoolBytesUsed] = useState(0);
  const [tapMs, setTapMs] = useState(30);
  const [keyPressBehaviorId, setKeyPressBehaviorId] = useState<
    number | undefined
  >(undefined);
  const [jsonText, setJsonText] = useState("[]");
  const [newMacroName, setNewMacroName] = useState("");
  const [renameTo, setRenameTo] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const subsystem = zmkApp?.findSubsystem(SUBSYSTEM_IDENTIFIER);
  const connection = zmkApp?.state.connection;
  const subsystemIndex = subsystem?.index;
  const serviceReady = connection && subsystemIndex !== undefined;

  const { call: callPayload, isCurrent } = useSessionRpc(
    connection,
    subsystemIndex
  );
  const selectedNameRef = useRef<string | null>(null);
  const loadSequence = useRef(0);
  const loadAbort = useRef<AbortController | null>(null);
  const activities = useRef(new Set<symbol>());
  const selectName = useCallback((name: string | null) => {
    selectedNameRef.current = name;
    setSelectedName(name);
  }, []);
  const beginActivity = useCallback(() => {
    const token = Symbol();
    activities.current.add(token);
    if (isCurrent()) setIsLoading(true);
    return () => {
      activities.current.delete(token);
      if (isCurrent()) setIsLoading(activities.current.size > 0);
    };
  }, [isCurrent]);
  const callRPC = useCallback(
    async (request: Request, signal?: AbortSignal) => {
      const payload = await callPayload(
        Request.encode(request).finish(),
        signal
      );
      const response = Response.decode(payload);
      if (response.error) throw new Error(response.error.message);
      return response;
    },
    [callPayload]
  );

  const loadMacro = useCallback(
    async (slot: number, keyPressId = keyPressBehaviorId) => {
      const generation = ++loadSequence.current;
      loadAbort.current?.abort();
      const controller = new AbortController();
      loadAbort.current = controller;
      const target = macros.find((item) => item.slot === slot);
      if (target) selectedNameRef.current = target.name;
      const finishActivity = beginActivity();
      setMessage(null);
      try {
        const response = await callRPC(
          Request.create({ getMacro: { slot } }),
          controller.signal
        );
        if (generation !== loadSequence.current) return;
        const macro = response.getMacro?.macro;
        if (!macro) throw new Error("Macro was missing from RPC response");

        const steps = macro.steps.map(runtimeStepFromRpc);
        selectName(macro.name);
        setLoadedMacro({ slot: macro.slot, name: macro.name, steps });
        setRenameTo(macro.name);
        setJsonText(
          JSON.stringify(
            toKeyboardAbyssSteps(steps, { keyPressBehaviorId: keyPressId }),
            null,
            2
          )
        );
      } catch (error) {
        if (generation !== loadSequence.current || isRetiredRequest(error))
          return;
        setMessage(
          error instanceof Error ? error.message : "Failed to load macro"
        );
      } finally {
        finishActivity();
        if (loadAbort.current === controller) loadAbort.current = null;
      }
    },
    [callRPC, keyPressBehaviorId, macros, beginActivity, selectName]
  );

  const refreshList = useCallback(async () => {
    const selectionAtStart = loadSequence.current;
    const desiredName = selectedNameRef.current;
    const finishActivity = beginActivity();
    setMessage(null);
    try {
      const response = await callRPC(Request.create({ listMacros: {} }));
      const list = response.listMacros?.macros ?? [];
      setMacros(
        list.map((macro) => ({
          slot: macro.slot,
          name: macro.name,
          encodedSize: macro.encodedSize,
          hasUnsavedChanges: macro.hasUnsavedChanges,
        }))
      );
      setMaxMacroBytes(response.listMacros?.maxMacroBytes || 64);
      setMaxNameLength(response.listMacros?.maxNameLength || 32);
      const globalSettings = await callRPC(
        Request.create({ getMacroGlobalSettings: {} })
      );
      const settings = globalSettings.getMacroGlobalSettings?.settings;
      const nextKeyPressBehaviorId = settings?.keyPressBehaviorId || undefined;
      setTapMs(settings?.tapMs ?? 30);
      setKeyPressBehaviorId(nextKeyPressBehaviorId);
      setPoolBytesTotal(settings?.poolBytesTotal ?? 0);
      setPoolBytesUsed(settings?.poolBytesUsed ?? 0);
      if (loadSequence.current === selectionAtStart) {
        if (list.length > 0) {
          const stillSelected = list.find((m) => m.name === desiredName);
          await loadMacro(
            (stillSelected ?? list[0]).slot,
            nextKeyPressBehaviorId
          );
        } else {
          selectName(null);
          setLoadedMacro(null);
        }
      }
    } catch (error) {
      if (loadSequence.current !== selectionAtStart || isRetiredRequest(error))
        return;
      setMessage(
        error instanceof Error ? error.message : "Failed to list macros"
      );
    } finally {
      finishActivity();
    }
  }, [callRPC, loadMacro, beginActivity, selectName]);

  useEffect(() => {
    if (!serviceReady) return;
    const timer = window.setTimeout(() => void refreshList(), 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceReady]);

  if (!zmkApp) return null;

  if (!subsystem) {
    return (
      <section className="panel">
        <p className="message warning">
          Subsystem "{SUBSYSTEM_IDENTIFIER}" was not found. Build firmware with
          runtime macro RPC enabled.
        </p>
      </section>
    );
  }

  const updateStep = (stepIndex: number, nextStep: RuntimeMacroStep) => {
    if (!loadedMacro) return;
    setLoadedMacro({
      ...loadedMacro,
      steps: loadedMacro.steps.map((step, index) =>
        index === stepIndex ? nextStep : step
      ),
    });
  };

  const removeStep = (stepIndex: number) => {
    if (!loadedMacro) return;
    const steps = loadedMacro.steps.filter((_, index) => index !== stepIndex);
    setLoadedMacro({ ...loadedMacro, steps });
    if (editorEncoding(steps, keyPressBehaviorId).error === null) {
      setJsonText(
        JSON.stringify(
          toKeyboardAbyssSteps(steps, { keyPressBehaviorId }),
          null,
          2
        )
      );
    }
  };

  const addStep = () => {
    if (!loadedMacro) return;
    setLoadedMacro({
      ...loadedMacro,
      steps: [...loadedMacro.steps, DEFAULT_STEP],
    });
  };

  const saveMacro = async (persist: boolean) => {
    if (!loadedMacro) return;
    const finishActivity = beginActivity();
    setMessage(null);

    try {
      validateEditorSteps(loadedMacro.steps);
      const codecOptions = { keyPressBehaviorId };
      const rpcSteps = compactKeyTapSteps(loadedMacro.steps, codecOptions);
      const encodedMacro = encodeRuntimeMacro(rpcSteps, codecOptions);
      if (encodedMacro.length > maxMacroBytes) {
        throw new Error(
          `Encoded macro is ${encodedMacro.length} bytes; limit is ${maxMacroBytes}`
        );
      }

      await callRPC(
        Request.create({
          setMacroStepCount: {
            slot: loadedMacro.slot,
            stepCount: rpcSteps.length,
            persist,
          },
        })
      );
      for (const [stepIndex, step] of rpcSteps.entries()) {
        await callRPC(
          Request.create({
            setMacroStep: {
              slot: loadedMacro.slot,
              stepIndex,
              step: runtimeStepToRpc(step),
              persist,
            },
          })
        );
      }

      setJsonText(
        JSON.stringify(toKeyboardAbyssSteps(rpcSteps, codecOptions), null, 2)
      );
      setMessage(
        persist ? "Saved to persistent settings" : "Updated in memory"
      );
      await refreshList();
    } catch (error) {
      if (isRetiredRequest(error)) return;
      setMessage(
        error instanceof Error ? error.message : "Failed to save macro"
      );
    } finally {
      finishActivity();
    }
  };

  const saveTapMs = async (persist: boolean) => {
    const finishActivity = beginActivity();
    setMessage(null);

    try {
      if (!Number.isInteger(tapMs) || tapMs < 0 || tapMs > MAX_TAP_MS) {
        throw new Error(
          `Tap ms must be an integer between 0 and ${MAX_TAP_MS}`
        );
      }
      await callRPC(
        Request.create({
          setTapMs: {
            tapMs,
            persist,
          },
        })
      );
      setMessage(
        persist
          ? "Saved tap_ms to persistent settings"
          : "Updated tap_ms in memory"
      );
    } catch (error) {
      if (isRetiredRequest(error)) return;
      setMessage(
        error instanceof Error ? error.message : "Failed to save tap_ms"
      );
    } finally {
      finishActivity();
    }
  };

  // Create/delete/rename are macro-domain RPCs on this module's own
  // subsystem: the client addresses a macro by name and never needs to know
  // it is stored as a custom-settings keyspace entry.
  const createMacro = async () => {
    const name = newMacroName.trim();
    if (!name) return;

    const finishActivity = beginActivity();
    setMessage(null);
    try {
      await callRPC(Request.create({ createMacro: { name, persist: false } }));
      setNewMacroName("");
      setMessage(`Created "${name}"`);
      selectName(name);
      await refreshList();
    } catch (error) {
      if (isRetiredRequest(error)) return;
      setMessage(
        error instanceof Error ? error.message : "Failed to create macro"
      );
    } finally {
      finishActivity();
    }
  };

  const deleteMacro = async () => {
    if (!loadedMacro) return;

    const finishActivity = beginActivity();
    setMessage(null);
    try {
      await callRPC(
        Request.create({ deleteMacro: { name: loadedMacro.name } })
      );
      setLoadedMacro(null);
      selectName(null);
      setJsonText("[]");
      setMessage(`Deleted "${loadedMacro.name}"`);
      await refreshList();
    } catch (error) {
      if (isRetiredRequest(error)) return;
      setMessage(
        error instanceof Error ? error.message : "Failed to delete macro"
      );
    } finally {
      finishActivity();
    }
  };

  const renameMacro = async () => {
    if (!loadedMacro) return;
    const newName = renameTo.trim();
    if (!newName || newName === loadedMacro.name) return;

    const finishActivity = beginActivity();
    setMessage(null);
    try {
      // RenameMacro renames in place: the macro keeps its slot (and so its
      // keymap binding) and body, and is unchanged if the rename fails.
      await callRPC(
        Request.create({
          renameMacro: {
            oldName: loadedMacro.name,
            newName,
            persist: false,
          },
        })
      );
      setMessage(`Renamed to "${newName}"`);
      selectName(newName);
      await refreshList();
    } catch (error) {
      if (isRetiredRequest(error)) return;
      setMessage(
        error instanceof Error ? error.message : "Failed to rename macro"
      );
    } finally {
      finishActivity();
    }
  };

  // Reset restores a macro to its compile-time (devicetree) default: the
  // firmware overwrites it with that default body if one exists for its name,
  // A memory-only reset without a default is refused. The separate Delete
  // action explicitly requests durable deletion.
  const resetMacro = async () => {
    if (!loadedMacro) return;
    if (
      !window.confirm(
        `Reset "${loadedMacro.name}" to its compile-time default? ` +
          `Without a devicetree default it will remain unchanged; use Delete to remove it.`
      )
    ) {
      return;
    }

    const finishActivity = beginActivity();
    setMessage(null);
    try {
      const response = await callRPC(
        Request.create({
          resetMacro: { slot: loadedMacro.slot, persist: false },
        })
      );
      setMessage(response.status?.message ?? `Reset "${loadedMacro.name}"`);
      setLoadedMacro(null);
      selectName(null);
      setJsonText("[]");
      await refreshList();
    } catch (error) {
      if (isRetiredRequest(error)) return;
      setMessage(
        error instanceof Error ? error.message : "Failed to reset macro"
      );
    } finally {
      finishActivity();
    }
  };

  const applyPendingMacros = async (action: "save" | "discard") => {
    const finishActivity = beginActivity();
    setMessage(null);

    try {
      const response = await callRPC(
        Request.create(
          action === "save" ? { saveMacros: {} } : { discardMacros: {} }
        )
      );
      await refreshList();
      setMessage(
        response.status?.message ??
          (action === "save"
            ? "Saved pending macro changes"
            : "Discarded pending macro changes")
      );
    } catch (error) {
      if (isRetiredRequest(error)) return;
      setMessage(
        error instanceof Error
          ? error.message
          : `Failed to ${action} pending macro changes`
      );
    } finally {
      finishActivity();
    }
  };

  const importJson = () => {
    if (!loadedMacro) return;
    try {
      const codecOptions = { keyPressBehaviorId };
      const steps = compactKeyTapSteps(
        fromKeyboardAbyssSteps(JSON.parse(jsonText)),
        codecOptions
      );
      validateEditorSteps(steps);
      const encoded = encodeRuntimeMacro(steps, codecOptions);
      if (encoded.length > maxMacroBytes) {
        throw new Error(
          `Imported macro is ${encoded.length} bytes; limit is ${maxMacroBytes}`
        );
      }
      setLoadedMacro({ ...loadedMacro, steps });
      setMessage("Imported Keyboard Abyss macro steps");
    } catch (error) {
      if (isRetiredRequest(error)) return;
      setMessage(
        error instanceof Error ? error.message : "Failed to import JSON"
      );
    }
  };

  const encoding = loadedMacro
    ? editorEncoding(loadedMacro.steps, keyPressBehaviorId)
    : { size: 0, error: null };
  const encodedSize = encoding.size;

  return (
    <main className="workspace">
      <aside className="macro-list">
        <div className="section-title">
          <h2>Macros</h2>
          <button className="btn" onClick={refreshList} disabled={isLoading}>
            Refresh
          </button>
        </div>
        {poolBytesTotal > 0 && (
          <p
            className={
              poolBytesUsed >= poolBytesTotal
                ? "message warning pool-usage"
                : "message pool-usage"
            }
          >
            Shared macro pool: {poolBytesUsed}/{poolBytesTotal} B used
          </p>
        )}
        {macros.map((macro) => (
          <button
            key={macro.name}
            className={
              macro.name === selectedName ? "macro-row selected" : "macro-row"
            }
            onClick={() => loadMacro(macro.slot)}
          >
            <span>
              {macro.name || `(unnamed slot ${macro.slot})`}
              {macro.hasUnsavedChanges && (
                <span className="unsaved-dot" title="Unsaved changes">
                  {" "}
                  ●
                </span>
              )}
            </span>
            <small>
              slot {macro.slot} · {macro.encodedSize} B
              {macro.hasUnsavedChanges && " · unsaved"}
            </small>
          </button>
        ))}
        <div className="create-macro">
          <input
            value={newMacroName}
            maxLength={maxNameLength}
            placeholder="New macro name"
            onChange={(event) => setNewMacroName(event.target.value)}
          />
          <button
            className="btn"
            onClick={createMacro}
            disabled={isLoading || !newMacroName.trim()}
          >
            Create
          </button>
        </div>
      </aside>

      <section className="editor">
        {loadedMacro ? (
          <>
            <div className="global-settings">
              <label>
                Tap ms
                <input
                  type="number"
                  min={0}
                  max={MAX_TAP_MS}
                  value={tapMs}
                  onChange={(event) =>
                    setTapMs(numericValue(event.target.value))
                  }
                />
              </label>
              <button
                className="btn"
                onClick={() => saveTapMs(false)}
                disabled={isLoading}
              >
                Write Memory
              </button>
              <button
                className="btn"
                onClick={() => saveTapMs(true)}
                disabled={isLoading}
              >
                Save
              </button>
            </div>

            <div className="editor-head">
              <label>
                Name (slot {loadedMacro.slot})
                <input
                  value={renameTo}
                  maxLength={maxNameLength}
                  onChange={(event) => setRenameTo(event.target.value)}
                />
              </label>
              <button
                className="btn"
                onClick={renameMacro}
                disabled={
                  isLoading || !renameTo.trim() || renameTo === loadedMacro.name
                }
              >
                Rename
              </button>
              <div
                className={
                  encodedSize > maxMacroBytes ? "byte-count over" : "byte-count"
                }
              >
                {encodedSize}/{maxMacroBytes} B
              </div>
            </div>

            {encoding.error && (
              <p className="message error" role="alert">
                {encoding.error}
              </p>
            )}
            <div className="steps">
              {loadedMacro.steps.map((step, index) => (
                <StepEditor
                  key={index}
                  step={step}
                  onChange={(nextStep) => updateStep(index, nextStep)}
                  onRemove={() => removeStep(index)}
                />
              ))}
            </div>

            <div className="actions">
              <button className="btn" onClick={addStep}>
                Add Step
              </button>
              <button
                className="btn"
                onClick={() => saveMacro(false)}
                disabled={isLoading || encoding.error !== null}
              >
                Write Memory
              </button>
              <button
                className="btn primary"
                onClick={() => saveMacro(true)}
                disabled={isLoading || encoding.error !== null}
              >
                Save
              </button>
              <button
                className="btn"
                onClick={() => applyPendingMacros("save")}
                disabled={isLoading}
              >
                Save Pending
              </button>
              <button
                className="btn"
                onClick={() => applyPendingMacros("discard")}
                disabled={isLoading}
              >
                Discard Pending
              </button>
              <button className="btn" onClick={resetMacro} disabled={isLoading}>
                Reset to Default
              </button>
              <button
                className="btn danger"
                onClick={deleteMacro}
                disabled={isLoading}
              >
                Delete
              </button>
            </div>

            <div className="json-pane">
              <div className="section-title">
                <h2>Keyboard Abyss Steps</h2>
                <button className="btn" onClick={importJson}>
                  Import
                </button>
              </div>
              <textarea
                value={jsonText}
                onChange={(event) => setJsonText(event.target.value)}
                spellCheck={false}
              />
            </div>
          </>
        ) : (
          <p>No macro selected. Create one to get started.</p>
        )}

        {message && <p className="message">{message}</p>}
      </section>
    </main>
  );
}

function validateEditorSteps(steps: RuntimeMacroStep[]) {
  for (const step of steps) {
    if (
      step.action === "delay" &&
      (!Number.isInteger(step.delayMs) ||
        step.delayMs < 0 ||
        step.delayMs > MAX_DELAY_MS)
    ) {
      throw new Error(
        `Delay ms must be an integer between 0 and ${MAX_DELAY_MS}`
      );
    }
  }
}
function editorEncoding(
  steps: RuntimeMacroStep[],
  keyPressBehaviorId?: number
): { size: number; error: string | null } {
  try {
    validateEditorSteps(steps);
    return {
      size: encodeRuntimeMacro(steps, { keyPressBehaviorId }).length,
      error: null,
    };
  } catch (error) {
    return {
      size: 0,
      error: error instanceof Error ? error.message : "Invalid macro step",
    };
  }
}

function numericValue(value: string) {
  return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
}

function formatPackedKeys(packedKeys: number[]) {
  return packedKeys
    .map((value) => value.toString(16).padStart(2, "0"))
    .join(" ");
}

function parsePackedKeys(value: string) {
  if (value.trim() === "") return [];
  return value
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((part) => {
      const parsed = Number.parseInt(part.replace(/^0x/i, ""), 16);
      return Number.isFinite(parsed) ? Math.max(0, Math.min(255, parsed)) : 0;
    });
}

function StepEditor({
  step,
  onChange,
  onRemove,
}: {
  step: RuntimeMacroStep;
  onChange: (step: RuntimeMacroStep) => void;
  onRemove: () => void;
}) {
  const setAction = (action: RuntimeMacroStep["action"]) => {
    if (action === "delay") {
      onChange({ action: "delay", delayMs: 10 });
    } else if (action === "keySequence") {
      onChange({ action: "keySequence", packedKeys: [] });
    } else if (action === "tap") {
      onChange({
        action: "tap",
        behaviorId: 0,
        param1: 0,
        param2: 0,
      });
    } else {
      onChange({ action, behaviorId: 0, param1: 0, param2: 0 });
    }
  };

  return (
    <div className="step-row">
      <select
        value={step.action}
        onChange={(event) => setAction(event.target.value as never)}
      >
        <option value="tap">Tap</option>
        <option value="keySequence">Key Seq</option>
        <option value="down">Down</option>
        <option value="up">Up</option>
        <option value="delay">Delay</option>
      </select>

      {step.action === "delay" ? (
        <label>
          Delay ms
          <input
            type="number"
            min={0}
            max={MAX_DELAY_MS}
            value={step.delayMs}
            onChange={(event) =>
              onChange({
                action: "delay",
                delayMs: numericValue(event.target.value),
              })
            }
          />
        </label>
      ) : step.action === "keySequence" ? (
        <label>
          Packed keys
          <input
            value={formatPackedKeys(step.packedKeys)}
            onChange={(event) =>
              onChange({
                action: "keySequence",
                packedKeys: parsePackedKeys(event.target.value),
              })
            }
          />
        </label>
      ) : (
        <>
          <label>
            Behavior ID
            <input
              type="number"
              min={0}
              value={step.behaviorId}
              onChange={(event) =>
                onChange({
                  ...step,
                  behaviorId: numericValue(event.target.value),
                })
              }
            />
          </label>
          <label>
            Param 1
            <input
              type="number"
              min={0}
              value={step.param1}
              onChange={(event) =>
                onChange({ ...step, param1: numericValue(event.target.value) })
              }
            />
          </label>
          <label>
            Param 2
            <input
              type="number"
              min={0}
              value={step.param2}
              onChange={(event) =>
                onChange({ ...step, param2: numericValue(event.target.value) })
              }
            />
          </label>
        </>
      )}

      <button className="btn danger" onClick={onRemove}>
        Remove
      </button>
    </div>
  );
}

export default App;
