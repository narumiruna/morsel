import { act, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { ThemeProvider, useAppearance } from "./theme"

function AppearanceValue() {
  return <output aria-label="Effective appearance">{useAppearance()}</output>
}

describe("ThemeProvider appearance context", () => {
  it.each(["light", "dark"] as const)("exposes persisted %s appearance", (appearance) => {
    localStorage.setItem("morsel-theme", appearance)
    render(
      <ThemeProvider>
        <AppearanceValue />
      </ThemeProvider>,
    )
    expect(screen.getByLabelText("Effective appearance")).toHaveTextContent(appearance)
  })

  it("updates system appearance consumers", () => {
    let listener: ((event: MediaQueryListEvent) => void) | undefined
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      media: "(prefers-color-scheme: dark)",
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: (_type: string, next: (event: MediaQueryListEvent) => void) => {
        listener = next
      },
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })
    render(
      <ThemeProvider>
        <AppearanceValue />
      </ThemeProvider>,
    )
    expect(screen.getByLabelText("Effective appearance")).toHaveTextContent("light")
    act(() => listener?.({ matches: true } as MediaQueryListEvent))
    expect(screen.getByLabelText("Effective appearance")).toHaveTextContent("dark")
  })
})
