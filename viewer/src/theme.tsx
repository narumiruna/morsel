import { Select, Theme } from "@radix-ui/themes"
import { type ReactNode, useEffect, useState } from "react"

export type ThemeMode = "system" | "light" | "dark"

const storageKey = "morsel-theme"

function initialMode(): ThemeMode {
  const stored = localStorage.getItem(storageKey)
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "system"
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(initialMode)
  const [media] = useState(() => window.matchMedia("(prefers-color-scheme: dark)"))
  const [systemDark, setSystemDark] = useState(media.matches)

  useEffect(() => {
    const update = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [media])

  const appearance = mode === "system" ? (systemDark ? "dark" : "light") : mode
  const updateMode = (next: string) => {
    if (next !== "system" && next !== "light" && next !== "dark") return
    localStorage.setItem(storageKey, next)
    setMode(next)
  }

  return (
    <Theme appearance={appearance} accentColor="orange" grayColor="sand" radius="medium">
      <div data-theme-mode={mode} data-appearance={appearance}>
        <div className="theme-control">
          <span>Theme</span>
          <Select.Root value={mode} onValueChange={updateMode}>
            <Select.Trigger aria-label="Theme" />
            <Select.Content>
              <Select.Item value="system">System</Select.Item>
              <Select.Item value="light">Light</Select.Item>
              <Select.Item value="dark">Dark</Select.Item>
            </Select.Content>
          </Select.Root>
        </div>
        {children}
      </div>
    </Theme>
  )
}
