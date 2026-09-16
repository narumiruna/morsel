import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { DiagramViewer } from "./DiagramViewer"

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><text>A</text></svg>'

describe("DiagramViewer", () => {
  it("exposes actions without a menu and supports zoom and source toggling", () => {
    render(<DiagramViewer svg={svg} source="graph TD; A-->B" />)
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Download SVG" })).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }))
    expect(screen.getByLabelText("Current zoom")).toHaveTextContent("125%")
    expect(screen.getByRole("img")).toHaveStyle({ width: "125%" })
    fireEvent.click(screen.getByRole("button", { name: "Reset zoom" }))
    expect(screen.getByLabelText("Current zoom")).toHaveTextContent("100%")
    fireEvent.click(screen.getByRole("button", { name: "Show source" }))
    expect(screen.getByText("graph TD; A-->B")).toBeVisible()
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Show diagram" }))
    expect(screen.getByRole("img")).toBeVisible()
  })

  it("copies source and reports clipboard failures", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
    render(<DiagramViewer svg={svg} source="graph TD; A-->B" />)
    fireEvent.click(screen.getByRole("button", { name: "Copy source" }))
    expect(await screen.findByText("Copied to clipboard.")).toBeVisible()
    expect(writeText).toHaveBeenCalledWith("graph TD; A-->B")
    writeText.mockRejectedValueOnce(new Error("Denied"))
    fireEvent.click(screen.getByRole("button", { name: "Copy SVG" }))
    expect(await screen.findByText("Copy failed. Check clipboard permissions.")).toBeVisible()
  })
})
