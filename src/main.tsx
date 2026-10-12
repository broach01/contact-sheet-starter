import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Admin } from "./Admin";
createRoot(document.getElementById("root")!).render(
  location.pathname.startsWith("/admin") ? <Admin /> : <App />,
);
