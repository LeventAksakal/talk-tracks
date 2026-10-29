import { DemoPage } from "./pages/DemoPage";
import { LandingPage } from "./pages/LandingPage";
import { NotFound } from "./pages/NotFound";
import { TalkPage } from "./pages/TalkPage";
import { WatchPage } from "./pages/WatchPage";
import { RewindDemo } from "./playback/RewindDemo";
import { matchRoute, useLocation } from "./router";

export function App() {
  const { pathname } = useLocation();
  const route = matchRoute(pathname);
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      {route.page === "landing" ? <LandingPage /> : null}
      {route.page === "watch" ? <WatchPage key={route.room} room={route.room} /> : null}
      {route.page === "talk" ? <TalkPage key={route.room} room={route.room} /> : null}
      {route.page === "demo" ? <DemoPage /> : null}
      {route.page === "rewind-demo" ? <RewindDemo /> : null}
      {route.page === "not-found" ? <NotFound /> : null}
    </>
  );
}
