import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./ui/App";
import { boot, fail } from "./state/sync";

// Subscriptions start here, once, outside React.
boot().catch((e) => {
  console.error(e);
  fail("Something went wrong while loading. Reload the page.");
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
