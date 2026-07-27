import React from "react";
import ReactDOM from "react-dom/client";
import "@fortawesome/fontawesome-free/css/all.min.css";
import App from "./App";
import "./styles.css";
import "./styles/skin-hub.css";
import "./styles/skin-dream.css";

// Main window: render the full application
// Pet window now uses a separate entry point (pet.html → pet-main.tsx)
// for a lightweight bundle that doesn't load the full app.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
