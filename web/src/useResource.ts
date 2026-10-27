import { type DependencyList, useEffect, useState } from "react";

/**
 * An object with a lifecycle (a connection, a store) that lives exactly as long as the effect:
 * created on mount or when `deps` change, closed on cleanup. It has to be made in an effect, so
 * StrictMode's double mount closes the first one, and handed to render through state.
 */
export function useResource<T extends { close(): void }>(
  create: () => T | undefined,
  deps: DependencyList,
): T | undefined {
  const [value, setValue] = useState<T>();
  useEffect(() => {
    const v = create();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- publishing the resource is the point
    setValue(v);
    return () => {
      v?.close();
      setValue(undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the caller names the deps
  }, deps);
  return value;
}
