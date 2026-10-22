import * as Tooltip from "@radix-ui/react-tooltip"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import axe from "axe-core"
import { describe, expect, it, vi } from "vitest"
import { ThemeProvider } from "../theme"
import { ExamplePage } from "./ExamplePage"
import example from "./example.md?raw"

vi.mock("mermaid", () => ({
  default: { initialize: vi.fn(), render: vi.fn().mockResolvedValue({ svg: "<svg></svg>" }) },
}))

describe("ExamplePage", () => {
  it("renders a local Markdown fixture and reader controls without any requests", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const user = userEvent.setup()
    const copy = vi.spyOn(navigator.clipboard, "writeText")
    const { container } = render(
      <ThemeProvider>
        <Tooltip.Provider>
          <ExamplePage />
        </Tooltip.Provider>
      </ThemeProvider>,
    )
    expect(screen.getByRole("heading", { name: "Example document" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Reading Markdown" })).toBeInTheDocument()
    expect(screen.getByText("Bundled example · no share views used")).toBeInTheDocument()
    expect(screen.getByRole("table")).toBeInTheDocument()
    expect(container.querySelector("img, iframe, video, audio")).toBeNull()
    expect(screen.queryByRole("link", { name: "Open on GitHub" })).not.toBeInTheDocument()
    expect(await axe.run(container).then((result) => result.violations)).toEqual([])

    await user.click(screen.getByRole("button", { name: "Show raw Markdown" }))
    expect(container.querySelector(".raw-markdown")?.textContent).toBe(example)
    await user.click(screen.getByRole("button", { name: "Copy Markdown" }))
    expect(copy).toHaveBeenCalledWith(example)
    expect(await screen.findByText("Markdown copied")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Show rendered document" }))
    expect(screen.getByRole("heading", { name: "Example document" })).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
