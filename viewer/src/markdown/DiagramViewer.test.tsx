import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DiagramViewer } from "./DiagramViewer"
import { createPngExport, downloadDiagram } from "./diagramExport"

vi.mock("./diagramExport", () => ({
  createPngExport: vi.fn().mockResolvedValue(new Blob(["png"], { type: "image/png" })),
  downloadDiagram: vi.fn(),
}))

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><text>A</text></svg>'

function renderViewer(
  props: Partial<{
    appearance: "light" | "dark"
    refreshing: boolean
    renderError: string
    retryRender: () => void
  }> = {},
) {
  return render(<DiagramViewer kind="mermaid" svg={svg} source="graph TD; A-->B" {...props} />)
}

describe("DiagramViewer", () => {
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard")
  const exitFullscreen = Object.getOwnPropertyDescriptor(document, "exitFullscreen")
  const fullscreenElement = Object.getOwnPropertyDescriptor(document, "fullscreenElement")

  afterEach(() => {
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard)
    else Reflect.deleteProperty(navigator, "clipboard")
    if (exitFullscreen) Object.defineProperty(document, "exitFullscreen", exitFullscreen)
    else Reflect.deleteProperty(document, "exitFullscreen")
    if (fullscreenElement) Object.defineProperty(document, "fullscreenElement", fullscreenElement)
    else Reflect.deleteProperty(document, "fullscreenElement")
    expect(Object.getOwnPropertyDescriptor(navigator, "clipboard")).toEqual(clipboard)
    expect(Object.getOwnPropertyDescriptor(document, "fullscreenElement")).toEqual(
      fullscreenElement,
    )
  })

  it("keeps the initial status empty without whitespace nodes", () => {
    const { container } = renderViewer()
    const status = container.querySelector(".diagram-status")
    expect(status?.childNodes).toHaveLength(0)
    expect(status?.matches(":empty")).toBe(true)
    expect(status?.matches(".diagram-status:not(:empty)")).toBe(false)
  })

  it("exposes camera, source, copy, and export actions", () => {
    renderViewer()
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
    const controls = [
      "Zoom out",
      "Zoom in",
      "Fit to screen",
      "Reset zoom",
      "Fullscreen",
      "Show source",
      "Copy source",
      "Download SVG",
      "Download PNG",
    ].map((name) => screen.getByRole("button", { name }))
    expect(controls.every((control) => control.textContent === "")).toBe(true)
    expect(screen.getByRole("button", { name: "Fit to screen" })).not.toHaveAttribute(
      "aria-pressed",
    )

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }))
    expect(screen.getByLabelText("Current zoom")).toHaveTextContent("125%")
    expect(screen.getByRole("img").style.transform).toContain("scale(1.25)")
    fireEvent.click(screen.getByRole("button", { name: "Fit to screen" }))
    expect(screen.getByLabelText("Current zoom")).toHaveTextContent("100%")
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }))
    fireEvent.click(screen.getByRole("button", { name: "Reset zoom" }))
    expect(screen.getByLabelText("Current zoom")).toHaveTextContent("100%")
    fireEvent.click(screen.getByRole("button", { name: "Show source" }))
    expect(screen.getByText("graph TD; A-->B")).toBeVisible()
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Show diagram" }))
    expect(screen.getByRole("img")).toBeVisible()
  })

  it("preserves Mermaid presentation and SVG export", () => {
    const retryRender = vi.fn()
    const { container } = renderViewer({ renderError: "Render failed.", retryRender })
    const stage = screen.getByRole("img", { name: "Mermaid diagram" })
    expect(stage).toHaveClass("mermaid-diagram")
    expect(stage.parentElement).toBe(
      screen.getByRole("region", {
        name: "Interactive Mermaid diagram. Use arrow keys to pan, plus or minus to zoom, and zero to fit.",
      }),
    )
    expect(container.querySelector(".diagram-card")).toHaveAttribute("class", "diagram-card")
    fireEvent.click(screen.getByRole("button", { name: "Retry diagram" }))
    expect(retryRender).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole("button", { name: "Download SVG" }))
    expect(downloadDiagram).toHaveBeenCalledWith(expect.any(Blob), "svg", "mermaid-diagram")
  })

  it("supports keyboard zoom and fit without consuming inline touch", () => {
    renderViewer()
    const viewport = screen.getByRole("region", { name: /Interactive Mermaid diagram/ })
    fireEvent.keyDown(viewport, { key: "+" })
    expect(screen.getByLabelText("Current zoom")).toHaveTextContent("125%")
    fireEvent.keyDown(viewport, { key: "0" })
    expect(screen.getByLabelText("Current zoom")).toHaveTextContent("100%")
    const touch = new Event("pointerdown", { bubbles: true, cancelable: true })
    Object.defineProperties(touch, {
      pointerId: { value: 1 },
      pointerType: { value: "touch" },
    })
    viewport.dispatchEvent(touch)
    expect(touch.defaultPrevented).toBe(false)
  })

  it("mounts tooltips inside the fullscreen card", async () => {
    const { container } = renderViewer()
    const card = container.querySelector(".diagram-card")
    expect(card).toBeInstanceOf(HTMLDivElement)
    if (!(card instanceof HTMLDivElement)) return

    Object.defineProperty(document, "fullscreenElement", { configurable: true, value: card })
    fireEvent(document, new Event("fullscreenchange"))
    fireEvent.focus(screen.getByRole("button", { name: "Copy source" }))

    const tooltip = await screen.findByRole("tooltip")
    expect(tooltip).toHaveTextContent("Copy source")
    expect(card).toContainElement(tooltip)
  })

  it("enters and exits native fullscreen", async () => {
    const { container } = renderViewer()
    const card = container.querySelector(".diagram-card")
    if (!(card instanceof HTMLDivElement)) throw new Error("card missing")
    let active: Element | null = null
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => active,
    })
    card.requestFullscreen = vi.fn(async () => {
      active = card
      document.dispatchEvent(new Event("fullscreenchange"))
    })
    Object.defineProperty(document, "exitFullscreen", {
      configurable: true,
      value: vi.fn(async () => {
        active = null
        document.dispatchEvent(new Event("fullscreenchange"))
      }),
    })
    fireEvent.click(screen.getByRole("button", { name: "Fullscreen" }))
    await screen.findByRole("button", { name: "Exit fullscreen" })
    fireEvent.click(screen.getByRole("button", { name: "Exit fullscreen" }))
    await screen.findByRole("button", { name: "Fullscreen" })
    expect(card.requestFullscreen).toHaveBeenCalledOnce()
    expect(document.exitFullscreen).toHaveBeenCalledOnce()
  })

  it("cleans up when native fullscreen lacks an exit method", () => {
    const { container, unmount } = renderViewer()
    const card = container.querySelector(".diagram-card")
    if (!(card instanceof HTMLDivElement)) throw new Error("card missing")
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      value: card,
    })
    Reflect.deleteProperty(document, "exitFullscreen")
    expect(() => unmount()).not.toThrow()
  })

  it("falls back from native fullscreen and restores isolation, scrolling, and focus", async () => {
    const outside = document.createElement("aside")
    document.body.append(outside)
    const { container } = renderViewer()
    const card = container.querySelector(".diagram-card")
    if (!(card instanceof HTMLDivElement)) throw new Error("card missing")
    card.requestFullscreen = vi.fn().mockRejectedValue(new Error("denied"))
    const button = screen.getByRole("button", { name: "Fullscreen" })
    button.focus()
    fireEvent.click(button)

    await waitFor(() => expect(card).toHaveClass("diagram-expanded"))
    expect(outside.inert).toBe(true)
    expect(document.documentElement.style.overflow).toBe("hidden")
    fireEvent.keyDown(document, { key: "Escape" })
    await waitFor(() => expect(card).not.toHaveClass("diagram-expanded"))
    expect(outside.inert).not.toBe(true)
    expect(document.documentElement.style.overflow).toBe("")
    await waitFor(() => expect(button).toHaveFocus())
    outside.remove()
  })

  it("copies source and reports clipboard failures", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
    renderViewer()
    fireEvent.click(screen.getByRole("button", { name: "Copy source" }))
    const status = await screen.findByText("Copied to clipboard.")
    expect(status).toBeVisible()
    expect(status.matches(".diagram-status:not(:empty)")).toBe(true)
    expect(writeText).toHaveBeenCalledWith("graph TD; A-->B")
    writeText.mockRejectedValueOnce(new Error("Denied"))
    fireEvent.click(screen.getByRole("button", { name: "Copy source" }))
    expect(await screen.findByText("Copy failed. Check clipboard permissions.")).toBeVisible()
  })

  it("exports PNG once and preserves focus-visible feedback", async () => {
    renderViewer({ appearance: "dark" })
    const button = screen.getByRole("button", { name: "Download PNG" })
    button.focus()
    fireEvent.click(button)
    await waitFor(() => expect(createPngExport).toHaveBeenCalled())
    expect(createPngExport).toHaveBeenCalledWith(expect.any(SVGSVGElement), "dark")
    await screen.findByText("PNG download started.")
    expect(downloadDiagram).toHaveBeenCalledWith(expect.any(Blob), "png", "mermaid-diagram")
    expect(button).toHaveFocus()
  })

  it("disables duplicate PNG work while an export is active", async () => {
    let finish: ((blob: Blob) => void) | undefined
    vi.mocked(createPngExport).mockImplementationOnce(
      () =>
        new Promise<Blob>((resolve) => {
          finish = resolve
        }),
    )
    renderViewer()
    const button = screen.getByRole("button", { name: "Download PNG" })
    fireEvent.click(button)
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(createPngExport).toHaveBeenCalledOnce()
    await act(async () => finish?.(new Blob(["png"], { type: "image/png" })))
    await waitFor(() => expect(button).toBeEnabled())
  })

  it("shows a safe theme-refresh retry without replacing the diagram", () => {
    const retryRender = vi.fn()
    renderViewer({ renderError: "Theme refresh failed.", retryRender })
    expect(screen.getByRole("img", { name: "Mermaid diagram" })).toBeVisible()
    expect(screen.getByText("Theme refresh failed.")).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Retry diagram" }))
    expect(retryRender).toHaveBeenCalledOnce()
  })
})
