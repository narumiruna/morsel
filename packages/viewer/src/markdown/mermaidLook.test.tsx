import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { MermaidLookProvider, useMermaidLook } from "./mermaidLook"

function Preference({ name }: { name: string }) {
  const { look, updateLook } = useMermaidLook()
  return (
    <div>
      <output aria-label={name}>{look ?? "source"}</output>
      <button type="button" onClick={() => updateLook("handDrawn")}>
        {name} hand-drawn
      </button>
      <button type="button" onClick={() => updateLook("classic")}>
        {name} classic
      </button>
      <button type="button" onClick={() => updateLook(undefined)}>
        {name} source
      </button>
    </div>
  )
}

function renderPreferences() {
  return render(
    <MermaidLookProvider>
      <Preference name="First" />
      <Preference name="Second" />
    </MermaidLookProvider>,
  )
}

describe("Mermaid look preference", () => {
  it.each([null, "invalid", "neo"])("uses the source style for stored value %s", (stored) => {
    if (stored !== null) localStorage.setItem("morsel-mermaid-look", stored)
    renderPreferences()
    expect(screen.getByLabelText("First")).toHaveTextContent("source")
  })

  it.each(["classic", "handDrawn"])("restores the saved %s preference", (look) => {
    localStorage.setItem("morsel-mermaid-look", look)
    renderPreferences()
    expect(screen.getByLabelText("First")).toHaveTextContent(look)
    expect(screen.getByLabelText("Second")).toHaveTextContent(look)
  })

  it("shares changes and restores them after remounting", () => {
    const { unmount } = renderPreferences()
    fireEvent.click(screen.getByRole("button", { name: "First hand-drawn" }))
    expect(screen.getByLabelText("First")).toHaveTextContent("handDrawn")
    expect(screen.getByLabelText("Second")).toHaveTextContent("handDrawn")
    expect(localStorage.getItem("morsel-mermaid-look")).toBe("handDrawn")
    unmount()
    renderPreferences()
    expect(screen.getByLabelText("First")).toHaveTextContent("handDrawn")
    fireEvent.click(screen.getByRole("button", { name: "Second classic" }))
    expect(screen.getByLabelText("First")).toHaveTextContent("classic")
    expect(localStorage.getItem("morsel-mermaid-look")).toBe("classic")
  })

  it("clears the preference to restore source styles", () => {
    localStorage.setItem("morsel-mermaid-look", "handDrawn")
    renderPreferences()
    fireEvent.click(screen.getByRole("button", { name: "First source" }))
    expect(screen.getByLabelText("First")).toHaveTextContent("source")
    expect(screen.getByLabelText("Second")).toHaveTextContent("source")
    expect(localStorage.getItem("morsel-mermaid-look")).toBeNull()
  })

  it("uses the source style when storage cannot be read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Storage blocked")
    })
    renderPreferences()
    expect(screen.getByLabelText("First")).toHaveTextContent("source")
  })

  it("keeps switching all diagrams when storage cannot be written", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage blocked")
    })
    renderPreferences()
    fireEvent.click(screen.getByRole("button", { name: "First hand-drawn" }))
    expect(screen.getByLabelText("Second")).toHaveTextContent("handDrawn")
    fireEvent.click(screen.getByRole("button", { name: "Second classic" }))
    expect(screen.getByLabelText("First")).toHaveTextContent("classic")
  })
})
