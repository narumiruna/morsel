import "@radix-ui/themes/styles.css"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import "./styles/app.css"
import { ThemeProvider } from "./theme"

const root = document.getElementById("root")
if (!root) throw new Error("missing application root")

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
)
