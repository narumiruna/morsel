import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { ThemeProvider, useAppearance } from "./theme"

function AppearanceValue() {
  return <output aria-label="Effective appearance">{useAppearance()}</output>
}

describe("ThemeProvider appearance context", () => {
  it.each([
    ["light", "light", "orange", "sand"],
    ["sepia", "light", "amber", "sand"],
    ["sage", "light", "jade", "sage"],
    ["dark", "dark", "orange", "sand"],
    ["midnight", "dark", "cyan", "slate"],
  ] as const)(
    "restores the %s theme with %s appearance",
    (mode, appearance, accentColor, grayColor) => {
      localStorage.setItem("morsel-theme", mode)
      const { container } = render(
        <ThemeProvider>
          <AppearanceValue />
        </ThemeProvider>,
      )

      expect(screen.getByLabelText("Effective appearance")).toHaveTextContent(appearance)
      const theme = container.querySelector(`[data-theme-mode="${mode}"]`)
      expect(theme).toHaveAttribute("data-appearance", appearance)
      expect(theme).toHaveAttribute("data-accent-color", accentColor)
      expect(theme).toHaveAttribute("data-gray-color", grayColor)
    },
  )

  it("offers and persists every theme", async () => {
    render(
      <ThemeProvider>
        <AppearanceValue />
      </ThemeProvider>,
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole("combobox", { name: "Theme" }))
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "System",
      "Light",
      "Sepia",
      "Sage",
      "Dark",
      "Midnight",
    ])
    await user.click(screen.getByRole("option", { name: "Sepia" }))

    expect(localStorage.getItem("morsel-theme")).toBe("sepia")
    expect(screen.getByLabelText("Effective appearance")).toHaveTextContent("light")
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
