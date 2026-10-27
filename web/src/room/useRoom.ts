import { useState, useSyncExternalStore } from "react";
import type { Transport } from "../transport/types";
import { useResource } from "../useResource";
import { type RoomStoreOptions, type RoomView, RoomStore } from "./store";

/** A RoomStore for the lifetime of the component, and its current view. */
export function useRoom(
  transport: Transport | undefined,
  room: string,
  options?: RoomStoreOptions,
): [RoomView | undefined, RoomStore | undefined] {
  // The options are read once: a store does not change policy midway.
  const [initialOptions] = useState(options);
  const store = useResource(
    () => (transport ? new RoomStore(transport, room, initialOptions) : undefined),
    [transport, room, initialOptions],
  );
  const view = useSyncExternalStore(store?.subscribe ?? noopSubscribe, store?.getSnapshot ?? undefinedSnapshot);
  return [view, store];
}

const noopSubscribe = () => () => {};
const undefinedSnapshot = () => undefined;
