import { type ComponentType, lazy, Suspense } from "react";
import { ChalkyLoading } from "./brand/states";
import { LandingPage } from "./pages/LandingPage";
import { NotFound } from "./pages/NotFound";
import { matchRoute, useLocation } from "./router";
import { loadDemo, loadRewindDemo, loadTalk, loadWatch } from "./routes";

/**
 * A route loaded on first visit. A redeploy removes the old hashed chunks, so a tab opened before it fails to load
 * one: reload the page once (it then gets the new index.html) rather than show nothing.
 */
function page<P extends object>(load: () => Promise<ComponentType<P>>) {
  return lazy(async () => {
    try {
      return { default: await load() };
    } catch (e) {
      const key = `tt-reloaded:${location.pathname}`;
      let reloaded = true;
      try {
        reloaded = sessionStorage.getItem(key) !== null;
        sessionStorage.setItem(key, "1");
      } catch {
        // no storage: do not risk a reload loop
      }
      if (reloaded) throw e;
      location.reload();
      return new Promise<never>(() => {});
    }
  });
}

const WatchPage = page(() => loadWatch().then((m) => m.WatchPage));
const TalkPage = page(() => loadTalk().then((m) => m.TalkPage));
const DemoPage = page(() => loadDemo().then((m) => m.DemoPage));
const RewindDemo = page(() => loadRewindDemo().then((m) => m.RewindDemo));

export function App() {
  const { pathname } = useLocation();
  const route = matchRoute(pathname);
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Suspense fallback={<ChalkyLoading>Loading…</ChalkyLoading>}>
        {route.page === "landing" ? <LandingPage /> : null}
        {route.page === "watch" ? <WatchPage key={route.room} room={route.room} /> : null}
        {route.page === "talk" ? <TalkPage key={route.room} room={route.room} /> : null}
        {route.page === "demo" ? <DemoPage /> : null}
        {route.page === "rewind-demo" ? <RewindDemo /> : null}
        {route.page === "not-found" ? <NotFound /> : null}
      </Suspense>
    </>
  );
}
