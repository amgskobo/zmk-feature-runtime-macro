import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { call_rpc } from "@zmkfirmware/zmk-studio-ts-client";
import { LockState } from "@zmkfirmware/zmk-studio-ts-client/core";
import { ZMKAppContext } from "@cormoran/zmk-studio-react-hook";

type Connection = Parameters<typeof call_rpc>[0];
const RPC_TIMEOUT_MS = 5000;
export class RetiredMacroRequest extends Error {
  constructor() {
    super("Runtime Macro request retired");
    this.name = "RetiredMacroRequest";
  }
}
export function isRetiredRequest(error: unknown) {
  return error instanceof RetiredMacroRequest;
}

function createRpcLifetime(
  connection: Connection | null | undefined,
  index: number | undefined,
  generation: number,
  sessionIdentity: string,
  initiallyActive: boolean
) {
  // This resource owns its mutable state privately. React memoizes its frozen
  // interface; effects and callbacks never mutate a memoized value or argument.
  let active = initiallyActive;
  const pending = new Set<() => void>();
  return Object.freeze({
    connection,
    index,
    generation,
    sessionIdentity,
    isActive: () => active,
    activate(enabled: boolean) {
      active = enabled;
    },
    retire() {
      active = false;
      for (const cancel of [...pending]) cancel();
      pending.clear();
    },
    track(cancel: () => void) {
      if (active) pending.add(cancel);
      else cancel();
    },
    untrack(cancel: () => void) {
      pending.delete(cancel);
    },
  });
}

export function useSessionRpc(
  connection: Connection | null | undefined,
  index: number | undefined,
  sessionIdentity = ""
) {
  const app = useContext(ZMKAppContext);
  const [authorization, setAuthorization] = useState({
    connection,
    generation: 0,
    locked: false,
  });
  const locked =
    authorization.connection === connection && authorization.locked;
  const generation = authorization.generation;
  const lifetime = useMemo(
    () =>
      createRpcLifetime(
        connection,
        index,
        generation,
        sessionIdentity,
        !locked
      ),
    // A catalog replacement and every lock transition get a distinct object;
    // old async continuations retain their retired object after unlocking.
    [connection, index, generation, locked, sessionIdentity]
  );
  useEffect(() => {
    lifetime.activate(!locked);
    return () => lifetime.retire();
  }, [lifetime, locked]);
  useEffect(() => {
    if (!app || !connection) return;
    let subscribed = true;
    const unsubscribe = app.onNotification({
      type: "core",
      callback: (notification) => {
        if (
          !subscribed ||
          (notification.lockStateChanged !==
            LockState.ZMK_STUDIO_CORE_LOCK_STATE_LOCKED &&
            notification.lockStateChanged !==
              LockState.ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED)
        )
          return;
        // Retire synchronously, before React commits the editor reset. No
        // pending full-body writer may dispatch its next request meanwhile.
        lifetime.retire();
        setAuthorization((previous) => ({
          connection,
          generation: previous.generation + 1,
          locked:
            notification.lockStateChanged ===
            LockState.ZMK_STUDIO_CORE_LOCK_STATE_LOCKED,
        }));
      },
    });
    return () => {
      subscribed = false;
      unsubscribe();
    };
  }, [app, connection, lifetime]);
  const isCurrent = useCallback(() => {
    const current = lifetime;
    return (
      current.isActive() &&
      current.connection === connection &&
      current.index === index
    );
  }, [connection, index, lifetime]);
  const call = useCallback(
    (payload: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> => {
      const current = lifetime;
      if (
        !current.isActive() ||
        current.connection !== connection ||
        current.index !== index ||
        signal?.aborted
      )
        return Promise.reject(new RetiredMacroRequest());
      if (!connection || index === undefined)
        return Promise.reject(
          new Error("Runtime macro subsystem is not connected")
        );
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error?: unknown, result?: Uint8Array) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          current.untrack(cancel);
          signal?.removeEventListener("abort", cancel);
          if (result === undefined) reject(error);
          else resolve(result);
        };
        const cancel = () => finish(new RetiredMacroRequest());
        const timer = window.setTimeout(
          () => finish(new Error("Runtime Macro RPC request timed out")),
          RPC_TIMEOUT_MS
        );
        current.track(cancel);
        if (settled) return;
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) {
          cancel();
          return;
        }
        try {
          Promise.resolve(
            call_rpc(connection, {
              custom: { call: { subsystemIndex: index, payload } },
            })
          ).then(
            (response) => {
              const data = response?.custom?.call?.payload;
              if (!data) finish(new Error("Empty RPC response"));
              else finish(undefined, data);
            },
            (error: unknown) => finish(error)
          );
        } catch (error) {
          finish(error);
        }
      });
    },
    [connection, index, lifetime]
  );
  return { call, isCurrent, generation, locked };
}
