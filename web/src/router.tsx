import { type AnchorHTMLAttributes, type MouseEvent, useSyncExternalStore } from "react";

// A tiny pathname router: four routes do not need a library.

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

export function navigate(to: string): void {
  window.history.pushState(null, "", to);
  for (const fn of [...listeners]) fn();
}

export function useLocation(): { pathname: string; search: string } {
  const href = useSyncExternalStore(subscribe, () => window.location.pathname + window.location.search);
  const url = new URL(href, "http://x");
  return { pathname: url.pathname, search: url.search };
}

export type Route =
  | { page: "landing" }
  | { page: "watch"; room: string }
  | { page: "talk"; room: string }
  | { page: "demo" }
  | { page: "not-found" };

export function matchRoute(pathname: string): Route {
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length === 0) return { page: "landing" };
  if (parts[0] === "demo" && parts.length === 1) return { page: "demo" };
  if (parts[0] === "watch" && parts.length === 2 && parts[1]) return { page: "watch", room: parts[1] };
  if (parts[0] === "talk" && parts.length === 2 && parts[1]) return { page: "talk", room: parts[1] };
  return { page: "not-found" };
}

export function Link({ href, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(href);
  };
  return <a href={href} onClick={handle} {...rest} />;
}
