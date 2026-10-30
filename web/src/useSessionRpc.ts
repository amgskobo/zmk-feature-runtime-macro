import { useCallback, useEffect, useRef } from "react";
import { call_rpc } from "@zmkfirmware/zmk-studio-ts-client";

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

export function useSessionRpc(
  connection: Connection | null | undefined,
  index: number | undefined
) {
  const lifetime = useRef<{
    connection: typeof connection;
    index: typeof index;
    active: boolean;
    pending: Set<() => void>;
  } | null>(null);
  useEffect(() => {
    const current = {
      connection,
      index,
      active: true,
      pending: new Set<() => void>(),
    };
    lifetime.current = current;
    return () => {
      current.active = false;
      for (const cancel of [...current.pending]) cancel();
    };
  }, [connection, index]);
  const isCurrent = useCallback(() => {
    const current = lifetime.current;
    return (
      current?.active === true &&
      current.connection === connection &&
      current.index === index
    );
  }, [connection, index]);
  const call = useCallback(
    (payload: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> => {
      const current = lifetime.current;
      if (
        !current?.active ||
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
          current.pending.delete(cancel);
          signal?.removeEventListener("abort", cancel);
          if (result === undefined) reject(error);
          else resolve(result);
        };
        const cancel = () => finish(new RetiredMacroRequest());
        current.pending.add(cancel);
        signal?.addEventListener("abort", cancel, { once: true });
        const timer = window.setTimeout(
          () => finish(new Error("Runtime Macro RPC request timed out")),
          RPC_TIMEOUT_MS
        );
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
    [connection, index]
  );
  return { call, isCurrent };
}
