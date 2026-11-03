// Its own module so the app shell can set it without loading the MoQ stack (the hub's first paint carries none).
import { createContext } from "react";

/**
 * The prefix a page reads from the relay (`talk/<room>` on a watch page), set by the route: its transports ask the
 * relay for that prefix's announcements only. Unset, they ask for every broadcast (the hub lists them all).
 */
export const RelayScope = createContext<string | undefined>(undefined);
