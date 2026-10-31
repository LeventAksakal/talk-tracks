import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import "./theme/fonts.css";
import "./theme/tokens.css";
import "./app.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
