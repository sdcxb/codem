import React from "react";
import ReactDOM from "react-dom/client";
import "@fortawesome/fontawesome-free/css/all.min.css";
import App from "./App";
import { PetWindowApp } from "./components/PetWindowApp";
import "./styles.css";
import "./styles/skin-hub.css";
import "./styles/skin-dream.css";

// Detect if this is the pet window (loaded via ?window=pet)
const isPetWindow = new URLSearchParams(window.location.search).get("window") === "pet";

if (isPetWindow) {
  // Mark the document for pet-window-specific CSS (transparent background, no borders)
  document.documentElement.classList.add("pet-window-mode");
  // Pet window: render only the pet sprite, skip all heavy app initialization
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <PetWindowApp />
    </React.StrictMode>
  );
} else {
  // Main window: render the full application
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
