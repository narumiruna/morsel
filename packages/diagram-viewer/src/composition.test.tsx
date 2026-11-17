import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { type Ref, StrictMode } from "react"
import { describe, expect, it, vi } from "vitest"
import {
  DiagramActionButton,
  DiagramRoot,
  DiagramSource,
  DiagramStatus,
  DiagramToolbar,
  DiagramViewer,
  DiagramViewport,
  DiagramZoom,
  useDiagramAction,
} from "./index.js"

const svg = '<svg viewBox="0 0 100 50"><text>A</text></svg>'

function AppButton() {
  const action = useDiagramAction("zoomIn")
  return (
    <button {...action} className="app-button">
      <span aria-hidden="true">Custom icon</span>
    </button>
  )
}

function Composed() {
  return (
    <DiagramRoot
      source="<script>not HTML</script>"
      svg={svg}
      style={{ "--ndv-background": "#eee" } as React.CSSProperties}
    >
      <DiagramToolbar>
        <DiagramActionButton action="source" className="source-first">
          Source icon
        </DiagramActionButton>
        <AppButton />
        <DiagramZoom />
        <button type="button">App action</button>
      </DiagramToolbar>
      <DiagramViewport />
      <DiagramSource />
      <DiagramStatus />
    </DiagramRoot>
  )
}

function Host({
  contentVersion,
  stageRef,
}: {
  contentVersion: number
  stageRef: Ref<HTMLDivElement>
}) {
  return (
    <DiagramViewer source="chart" hostManaged contentVersion={contentVersion} stageRef={stageRef} />
  )
}

describe("composition", () => {
  it("omits and reorders actions, replaces icons/styles, and binds app buttons", () => {
    const { container } = render(<Composed />)
    expect(
      screen
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label") ?? button.textContent),
    ).toEqual(["Show source", "Zoom in", "App action"])
    expect(screen.queryByRole("button", { name: "Download PNG" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Show source" })).toHaveClass("source-first")
    expect(container.querySelector(".ndv-root")).toHaveStyle("--ndv-background: #eee")
    const custom = screen.getByRole("button", { name: "Zoom in" })
    expect(custom).toHaveClass("app-button")
    fireEvent.click(custom)
    expect(screen.getByLabelText("Current zoom")).toHaveTextContent("125%")
    fireEvent.click(screen.getByRole("button", { name: "Show source" }))
    expect(custom).toBeDisabled()
    expect(screen.getByRole("button", { name: "Show diagram" })).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    expect(screen.getByRole("region", { name: "Diagram source" })).toHaveTextContent(
      "<script>not HTML</script>",
    )
    expect(container.querySelector("script")).toBeNull()
  })

  it("keeps per-instance source IDs, state, and control bindings isolated", () => {
    const { container } = render(
      <>
        <DiagramViewer source="first" svg={svg} />
        <DiagramViewer source="second" svg={svg} />
      </>,
    )
    const roots = container.querySelectorAll<HTMLElement>(".ndv-root")
    const first = within(roots[0] as HTMLElement)
    const second = within(roots[1] as HTMLElement)
    const firstSource = first.getByRole("button", { name: "Show source" })
    expect(firstSource.getAttribute("aria-controls")).not.toBe(
      second.getByRole("button", { name: "Show source" }).getAttribute("aria-controls"),
    )
    fireEvent.click(first.getByRole("button", { name: "Zoom in" }))
    expect(first.getByLabelText("Current zoom")).toHaveTextContent("125%")
    expect(second.getByLabelText("Current zoom")).toHaveTextContent("100%")
    fireEvent.click(firstSource)
    expect(first.getByRole("region", { name: "Diagram source" })).toBeVisible()
    expect(second.queryByRole("region", { name: "Diagram source" })).not.toBeInTheDocument()
  })

  it("does not let toolbar navigation or source scrolling trigger the camera", () => {
    render(<Composed />)
    fireEvent.keyDown(screen.getByRole("button", { name: "Zoom in" }), { key: "+" })
    expect(screen.getByLabelText("Current zoom")).toHaveTextContent("100%")
    fireEvent.click(screen.getByRole("button", { name: "Show source" }))
    fireEvent.keyDown(screen.getByRole("region", { name: "Diagram source" }), { key: "+" })
    expect(screen.getByLabelText("Current zoom")).toHaveTextContent("100%")
  })

  it("preserves host-managed children through actions, refresh, and StrictMode replay", () => {
    let stage: HTMLDivElement | null = null
    const stageRef = (element: HTMLDivElement | null) => {
      stage = element
    }
    const { rerender, unmount } = render(
      <StrictMode>
        <Host contentVersion={0} stageRef={stageRef} />
      </StrictMode>,
    )
    const mount = stage as HTMLDivElement | null
    if (!mount) throw new Error("Host stage missing")
    mount.innerHTML = `${svg}<input aria-label="Live parameter" type="range">`
    const chart = mount.firstChild
    const parameter = screen.getByRole("slider", { name: "Live parameter" })
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }))
    rerender(
      <StrictMode>
        <Host contentVersion={1} stageRef={stageRef} />
      </StrictMode>,
    )
    expect(mount.firstChild).toBe(chart)
    expect(screen.getByRole("slider", { name: "Live parameter" })).toBe(parameter)
    fireEvent.click(screen.getByRole("button", { name: "Show source" }))
    fireEvent.click(screen.getByRole("button", { name: "Show diagram" }))
    expect(mount.firstChild).toBe(chart)
    unmount()
    expect(stage).toBeNull()
  })

  it("reports async clipboard busy and failure through the shared binding", async () => {
    let reject: ((reason: Error) => void) | undefined
    const writeText = vi.fn(
      () =>
        new Promise<void>((_, fail) => {
          reject = fail
        }),
    )
    const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard")
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
    try {
      render(<DiagramViewer source="source" svg={svg} />)
      const button = screen.getByRole("button", { name: "Copy source" })
      fireEvent.click(button)
      expect(button).toBeDisabled()
      expect(button).toHaveAttribute("aria-busy", "true")
      fireEvent.click(button)
      expect(writeText).toHaveBeenCalledOnce()
      await act(async () => reject?.(new Error("Denied")))
      expect(button).toBeEnabled()
      expect(screen.getByText("Copy failed. Check clipboard permissions.")).toHaveAttribute(
        "aria-live",
        "polite",
      )
    } finally {
      if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor)
      else Reflect.deleteProperty(navigator, "clipboard")
    }
  })
})
