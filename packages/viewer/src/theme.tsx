import { Select, Theme, type ThemeProps } from "@radix-ui/themes"
import { createContext, type ReactNode, useContext, useEffect, useState } from "react"

export type Appearance = "light" | "dark"

type ThemeOption = {
  value: "system" | "light" | "sepia" | "sage" | "dark" | "midnight"
  label: string
}

const themeOptions = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "sepia", label: "Sepia" },
  { value: "sage", label: "Sage" },
  { value: "dark", label: "Dark" },
  { value: "midnight", label: "Midnight" },
] as const satisfies readonly ThemeOption[]

export type ThemeMode = (typeof themeOptions)[number]["value"]
type FixedThemeMode = Exclude<ThemeMode, "system">
type ThemePreset = {
  appearance: Appearance
  accentColor: NonNullable<ThemeProps["accentColor"]>
  grayColor: NonNullable<ThemeProps["grayColor"]>
}

const themePresets = {
  light: { appearance: "light", accentColor: "orange", grayColor: "sand" },
  sepia: { appearance: "light", accentColor: "amber", grayColor: "sand" },
  sage: { appearance: "light", accentColor: "jade", grayColor: "sage" },
  dark: { appearance: "dark", accentColor: "orange", grayColor: "sand" },
  midnight: { appearance: "dark", accentColor: "cyan", grayColor: "slate" },
} as const satisfies Record<FixedThemeMode, ThemePreset>

const storageKey = "morsel-theme"
const AppearanceContext = createContext<Appearance>("light")

export function useAppearance(): Appearance {
  return useContext(AppearanceContext)
}

function isThemeMode(value: string | null): value is ThemeMode {
  return themeOptions.some((option) => option.value === value)
}

function initialMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(storageKey)
    return isThemeMode(stored) ? stored : "system"
  } catch {
    return "system"
  }
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

  const appearance =
    mode === "system" ? (systemDark ? "dark" : "light") : themePresets[mode].appearance
  const palette = mode === "system" ? themePresets[appearance] : themePresets[mode]
  const updateMode = (next: string) => {
    if (!isThemeMode(next)) return
    try {
      localStorage.setItem(storageKey, next)
    } catch {
      // Theme persistence is optional when storage is unavailable.
    }
    setMode(next)
  }

  return (
    <AppearanceContext.Provider value={appearance}>
      <Theme
        appearance={appearance}
        accentColor={palette.accentColor}
        grayColor={palette.grayColor}
        radius="medium"
        className="morsel-theme"
        data-theme-mode={mode}
        data-appearance={appearance}
      >
        <div className="theme-control">
          <span>Theme</span>
          <Select.Root value={mode} onValueChange={updateMode}>
            <Select.Trigger aria-label="Theme" />
            <Select.Content>
              {themeOptions.map((option) => (
                <Select.Item key={option.value} value={option.value}>
                  {option.label}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
        </div>
        {children}
      </Theme>
    </AppearanceContext.Provider>
  )
}
