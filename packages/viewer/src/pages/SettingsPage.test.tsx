import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import axe from "axe-core"
import { describe, expect, it, vi } from "vitest"
import { MermaidLookProvider } from "../markdown/mermaidLook"
import { ThemeProvider } from "../theme"
import { SettingsPage } from "./SettingsPage"

function renderSettings() {
  return render(
    <ThemeProvider>
      <MermaidLookProvider>
        <SettingsPage />
      </MermaidLookProvider>
    </ThemeProvider>,
  )
}

describe("SettingsPage", () => {
  it("offers accessible reader settings without account or network access", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const { container } = renderSettings()
    expect(screen.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible()
    expect(screen.getByRole("heading", { name: "Themes", level: 2 })).toBeVisible()
    expect(screen.getByRole("heading", { name: "Mermaid styles", level: 2 })).toBeVisible()
    expect(screen.getByRole("combobox", { name: "Theme" })).toHaveTextContent("System")
    expect(screen.getByRole("combobox", { name: "Mermaid style" })).toHaveTextContent(
      "Source style",
    )
    expect(await axe.run(container).then((result) => result.violations)).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("offers every theme and applies changes immediately", async () => {
    const { container } = renderSettings()
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
    expect(container.querySelector('[data-theme-mode="sepia"]')).toBeInTheDocument()
  })

  it.each([
    ["Classic", "classic"],
    ["Hand-drawn", "handDrawn"],
  ])("saves the %s Mermaid style without changing the theme", async (label, value) => {
    localStorage.setItem("morsel-theme", "dark")
    const { container } = renderSettings()
    const user = userEvent.setup()
    await user.click(screen.getByRole("combobox", { name: "Mermaid style" }))
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Source style",
      "Classic",
      "Hand-drawn",
    ])
    await user.click(screen.getByRole("option", { name: label }))
    expect(localStorage.getItem("morsel-mermaid-look")).toBe(value)
    expect(localStorage.getItem("morsel-theme")).toBe("dark")
    expect(container.querySelector('[data-theme-mode="dark"]')).toBeInTheDocument()
  })

  it("restores both existing preferences after the settings page remounts", async () => {
    const first = renderSettings()
    const user = userEvent.setup()
    await user.click(screen.getByRole("combobox", { name: "Theme" }))
    await user.click(screen.getByRole("option", { name: "Midnight" }))
    await user.click(screen.getByRole("combobox", { name: "Mermaid style" }))
    await user.click(screen.getByRole("option", { name: "Hand-drawn" }))
    first.unmount()
    const second = renderSettings()
    expect(screen.getByRole("combobox", { name: "Theme" })).toHaveTextContent("Midnight")
    expect(screen.getByRole("combobox", { name: "Mermaid style" })).toHaveTextContent("Hand-drawn")
    expect(second.container.querySelector('[data-appearance="dark"]')).toBeInTheDocument()
  })

  it("clears only the Mermaid preference when Source style is selected", async () => {
    localStorage.setItem("morsel-theme", "sage")
    localStorage.setItem("morsel-mermaid-look", "handDrawn")
    renderSettings()
    const user = userEvent.setup()
    await user.click(screen.getByRole("combobox", { name: "Mermaid style" }))
    await user.click(screen.getByRole("option", { name: "Source style" }))
    expect(localStorage.getItem("morsel-mermaid-look")).toBeNull()
    expect(localStorage.getItem("morsel-theme")).toBe("sage")
    expect(screen.getByRole("combobox", { name: "Theme" })).toHaveTextContent("Sage")
  })

  it("uses safe defaults for invalid saved preferences", () => {
    localStorage.setItem("morsel-theme", "invalid")
    localStorage.setItem("morsel-mermaid-look", "invalid")
    renderSettings()
    expect(screen.getByRole("combobox", { name: "Theme" })).toHaveTextContent("System")
    expect(screen.getByRole("combobox", { name: "Mermaid style" })).toHaveTextContent(
      "Source style",
    )
  })

  it("keeps both preferences usable when browser storage is unavailable", async () => {
    for (const method of ["getItem", "setItem", "removeItem"] as const) {
      vi.spyOn(Storage.prototype, method).mockImplementation(() => {
        throw new DOMException("Storage unavailable", "SecurityError")
      })
    }
    const { container } = renderSettings()
    const user = userEvent.setup()
    await user.click(screen.getByRole("combobox", { name: "Theme" }))
    await user.click(screen.getByRole("option", { name: "Dark" }))
    await user.click(screen.getByRole("combobox", { name: "Mermaid style" }))
    await user.click(screen.getByRole("option", { name: "Hand-drawn" }))
    expect(screen.getByRole("combobox", { name: "Mermaid style" })).toHaveTextContent("Hand-drawn")
    await user.click(screen.getByRole("combobox", { name: "Mermaid style" }))
    await user.click(screen.getByRole("option", { name: "Source style" }))
    expect(screen.getByRole("combobox", { name: "Mermaid style" })).toHaveTextContent(
      "Source style",
    )
    await waitFor(() =>
      expect(container.querySelector('[data-theme-mode="dark"]')).toBeInTheDocument(),
    )
  })
})
