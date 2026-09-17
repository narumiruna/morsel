import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ThemeProvider } from "../theme"
import { MarkdownDocument } from "./MarkdownDocument"

const mermaidMock = vi.hoisted(() => ({
  configuration: undefined as unknown,
  render: vi.fn(),
}))
vi.mock("mermaid", () => ({
  default: {
    initialize: (configuration: unknown) => {
      mermaidMock.configuration = configuration
    },
    render: mermaidMock.render,
  },
}))
const vegaEmbedMock = vi.hoisted(() => vi.fn())
vi.mock("vega-embed", () => ({ default: vegaEmbedMock }))
const exportMock = vi.hoisted(() => ({
  createPngExport: vi.fn(),
  downloadDiagram: vi.fn(),
}))
vi.mock("./diagramExport", () => exportMock)
const renderDiagram = mermaidMock.render
const finalizeChart = vi.fn()

beforeEach(() => {
  renderDiagram.mockReset()
  renderDiagram.mockResolvedValue({
    svg: '<svg viewBox="0 0 10 10"><title>Safe diagram</title><path d="M0 0" /></svg>',
  })
  exportMock.createPngExport.mockReset()
  exportMock.createPngExport.mockResolvedValue(new Blob(["png"], { type: "image/png" }))
  exportMock.downloadDiagram.mockReset()
  finalizeChart.mockReset()
  vegaEmbedMock.mockReset()
  vegaEmbedMock.mockImplementation(async (element: HTMLElement, spec: { description?: string }) => {
    element.setAttribute("role", "graphics-document")
    element.setAttribute("aria-label", spec.description ?? "Vega visualization")
    element.innerHTML = '<svg viewBox="0 0 10 10"><text>Vega chart</text></svg>'
    return { finalize: finalizeChart }
  })
})

describe("MarkdownDocument", () => {
  it("renders Markdown and GFM without authored HTML", () => {
    const { container } = render(
      <MarkdownDocument
        content={`# Heading

~~strike~~ and \`inline\`.

- [x] done

| A | B |
| - | - |
| 1 | 2 |

> quote

\`\`\`js
alert("escaped")
\`\`\`

<script data-evil="yes">window.pwned = true</script>`}
      />,
    )
    expect(screen.getByRole("heading", { name: "Heading" })).toBeInTheDocument()
    expect(container.querySelector("del")).toHaveTextContent("strike")
    expect(container.querySelector("table")).toBeInTheDocument()
    expect(container.querySelector('input[type="checkbox"]')).toBeDisabled()
    expect(container.querySelector("blockquote")).toHaveTextContent("quote")
    expect(container.querySelector("script")).not.toBeInTheDocument()
    expect(container.innerHTML).not.toContain("data-evil")
  })

  it("highlights fenced code without changing its source", () => {
    const { container } = render(
      <MarkdownDocument
        content={'```go\npackage main\n\nfunc main() {\n  println("hello")\n}\n```'}
      />,
    )
    const code = container.querySelector("pre code")
    expect(code).toHaveClass("hljs", "language-go")
    expect(code).toHaveTextContent('package main func main() { println("hello") }')
    expect(code?.querySelector(".hljs-keyword")).toHaveTextContent("package")
  })

  it("renders inline and display math with KaTeX trust disabled", () => {
    const { container } = render(
      <MarkdownDocument
        content={"Inline $x^2$\n\n$$\\frac{1}{2}$$\n\n$\\href{javascript:alert(1)}{bad}$"}
      />,
    )
    expect(container.querySelectorAll(".katex").length).toBeGreaterThan(1)
    expect(container.querySelector(".katex-html .mord")).toBeInTheDocument()
    expect(container.querySelector('.katex a[href*="javascript"]')).not.toBeInTheDocument()
    expect(container.querySelector("script")).not.toBeInTheDocument()
  })

  it("allows safe URLs and strips dangerous URLs and attributes", () => {
    const { container } = render(
      <MarkdownDocument
        content={`[safe](https://example.com) [mail](mailto:test@example.com) [bad](javascript:alert(1))

![safe](https://images.example/a.png) ![inline](data:image/png;base64,iVBORw0KGgo=)

![bad](javascript:alert(1)) ![vector](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)

<img src=x onerror="window.pwned=true"><svg onload="window.pwned=true"></svg>`}
      />,
    )
    const safe = screen.getByRole("link", { name: "safe" })
    expect(safe).toHaveAttribute("target", "_blank")
    expect(safe).toHaveAttribute("rel", "noopener noreferrer")
    expect(screen.getByText("bad").closest("a")).not.toHaveAttribute("href")
    const image = screen.getByAltText("safe")
    expect(image).toHaveAttribute("referrerpolicy", "no-referrer")
    expect(image).toHaveAttribute("loading", "lazy")
    expect(screen.getByAltText("inline")).toHaveAttribute(
      "src",
      "data:image/png;base64,iVBORw0KGgo=",
    )
    expect(screen.getByAltText("vector")).not.toHaveAttribute("src")
    expect(container.innerHTML).not.toMatch(/onerror|onload|<svg/i)
  })

  it("renders Vega-Lite blocks locally with locked embed options", async () => {
    const source = JSON.stringify({
      usermeta: { embedOptions: { actions: true, loader: { baseURL: "https://evil.example" } } },
      data: { values: [{ week: "W1", requests: 120 }] },
      description: "Weekly request volume",
      mark: "bar",
      encoding: {
        x: { field: "week", type: "nominal" },
        y: { field: "requests", type: "quantitative" },
      },
    })
    const { container } = render(
      <MarkdownDocument content={`Before\n\n\`\`\`vega-lite\n${source}\n\`\`\`\n\nAfter`} />,
    )

    expect(await screen.findByText("Vega chart")).toBeVisible()
    expect(screen.getByRole("graphics-document", { name: "Weekly request volume" })).toBeVisible()
    expect(container.querySelector("pre code.language-vega-lite")).not.toBeInTheDocument()
    expect(screen.getByText("Before")).toBeInTheDocument()
    expect(screen.getByText("After")).toBeInTheDocument()

    const [element, spec, options] = vegaEmbedMock.mock.calls[0] as [
      HTMLElement,
      Record<string, unknown>,
      {
        actions: boolean
        ast: boolean
        loader: {
          load: (uri: string) => Promise<string>
          sanitize: (uri: string) => Promise<{ href: string }>
        }
        mode: string
        renderer: string
        tooltip: boolean
      },
    ]
    expect(element).toHaveClass("vega-lite-render")
    expect(spec).not.toHaveProperty("usermeta")
    expect(options).toMatchObject({
      actions: false,
      ast: true,
      mode: "vega-lite",
      renderer: "svg",
      tooltip: false,
    })
    await expect(options.loader.load("https://evil.example/data.csv")).rejects.toThrow(
      "External resources are disabled",
    )
    await expect(options.loader.sanitize("https://evil.example/image.png")).rejects.toThrow(
      "External resources are disabled",
    )
  })

  it("rerenders Vega-Lite charts for the dark theme and finalizes old views", async () => {
    localStorage.setItem("morsel-theme", "light")
    render(
      <ThemeProvider>
        <MarkdownDocument content={'```vega-lite\n{"mark":"bar"}\n```'} />
      </ThemeProvider>,
    )
    await waitFor(() => expect(vegaEmbedMock).toHaveBeenCalledOnce())
    expect(vegaEmbedMock.mock.calls[0]?.[2]).toMatchObject({ theme: undefined })

    const user = userEvent.setup()
    await user.click(screen.getByRole("combobox", { name: "Theme" }))
    await user.click(screen.getByRole("option", { name: "Dark" }))
    await waitFor(() => expect(vegaEmbedMock).toHaveBeenCalledTimes(2))
    expect(finalizeChart).toHaveBeenCalledOnce()
    expect(vegaEmbedMock.mock.calls[1]?.[2]).toMatchObject({ theme: "dark" })
  })

  it("removes a superseded Vega-Lite render that finishes after a theme change", async () => {
    const finalizeLight = vi.fn()
    const finalizeDark = vi.fn()
    let finishLight: (() => void) | undefined
    vegaEmbedMock
      .mockImplementationOnce(
        (element: HTMLElement) =>
          new Promise<{ finalize: () => void }>((resolve) => {
            finishLight = () => {
              element.innerHTML = "<svg><text>Stale light chart</text></svg>"
              resolve({ finalize: finalizeLight })
            }
          }),
      )
      .mockImplementationOnce(async (element: HTMLElement) => {
        element.innerHTML = "<svg><text>Current dark chart</text></svg>"
        return { finalize: finalizeDark }
      })
    localStorage.setItem("morsel-theme", "light")
    const { container } = render(
      <ThemeProvider>
        <MarkdownDocument content={'```vega-lite\n{"mark":"bar"}\n```'} />
      </ThemeProvider>,
    )
    await waitFor(() => expect(vegaEmbedMock).toHaveBeenCalledOnce())

    const user = userEvent.setup()
    await user.click(screen.getByRole("combobox", { name: "Theme" }))
    await user.click(screen.getByRole("option", { name: "Dark" }))
    expect(await screen.findByText("Current dark chart")).toBeVisible()

    await act(async () => finishLight?.())
    await waitFor(() => expect(finalizeLight).toHaveBeenCalledOnce())
    expect(screen.queryByText("Stale light chart")).not.toBeInTheDocument()
    expect(container.querySelectorAll(".vega-lite-render")).toHaveLength(1)
  })

  it("isolates invalid, oversized, and excess Vega-Lite charts", async () => {
    const { rerender } = render(
      <MarkdownDocument content={"Before\n\n```vega-lite\nnot JSON\n```\n\nAfter"} />,
    )
    expect(
      await screen.findByText("This Vega-Lite chart could not be rendered."),
    ).toBeInTheDocument()
    expect(screen.getByText("Before")).toBeInTheDocument()
    expect(screen.getByText("After")).toBeInTheDocument()

    rerender(<MarkdownDocument content={`\`\`\`vega-lite\n${"x".repeat(50 * 1024 + 1)}\n\`\`\``} />)
    expect(screen.getByText("This chart exceeds the 50 KiB source limit.")).toBeInTheDocument()

    const charts = Array.from(
      { length: 21 },
      (_, index) => `\`\`\`vega-lite\n{"mark":"bar","description":"${index}"}\n\`\`\``,
    ).join("\n\n")
    rerender(<MarkdownDocument content={charts} />)
    expect(screen.getByText("Only the first 20 Vega-Lite charts are rendered.")).toBeInTheDocument()
    await waitFor(() => expect(vegaEmbedMock).toHaveBeenCalled())
  })

  it("renders Mermaid labels as sanitized SVG text", async () => {
    renderDiagram.mockResolvedValueOnce({
      svg: '<svg onload="alert(1)"><script>alert(1)</script><foreignObject>bad</foreignObject><text>Browser</text><path d="M0 0" /></svg>',
    })
    const { container } = render(<MarkdownDocument content={"```mermaid\ngraph TD; A-->B\n```"} />)
    await screen.findByLabelText("Mermaid diagram")
    expect(mermaidMock.configuration).toMatchObject({
      htmlLabels: false,
      securityLevel: "strict",
    })
    expect(renderDiagram).toHaveBeenCalledOnce()
    expect(container.querySelector("svg text")).toHaveTextContent("Browser")
    expect(container.innerHTML).not.toMatch(/onload|script|foreignObject/i)
  })

  it("defers offscreen Mermaid work until the preload observer intersects", async () => {
    let intersect: ((entries: Array<{ isIntersecting: boolean }>) => void) | undefined
    const disconnect = vi.fn()
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
          intersect = callback
        }
        observe() {}
        disconnect() {
          disconnect()
        }
      },
    )
    render(<MarkdownDocument content={"```mermaid\ngraph TD; A-->B\n```"} />)
    expect(screen.getByLabelText("Waiting to render Mermaid diagram")).toBeVisible()
    expect(renderDiagram).not.toHaveBeenCalled()
    act(() => intersect?.([{ isIntersecting: true }]))
    await screen.findByLabelText("Mermaid diagram")
    expect(renderDiagram).toHaveBeenCalledOnce()
    expect(disconnect).toHaveBeenCalled()
  })

  it("retries an invalid diagram while preserving its source", async () => {
    renderDiagram
      .mockRejectedValueOnce(new Error("bad diagram"))
      .mockResolvedValueOnce({ svg: '<svg viewBox="0 0 10 10"><text>Recovered</text></svg>' })
    render(<MarkdownDocument content={"```mermaid\ngraph TD; Broken-->\n```"} />)
    expect(await screen.findByText("This Mermaid diagram could not be rendered.")).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Retry diagram" }))
    expect(await screen.findByText("Recovered")).toBeVisible()
    expect(renderDiagram).toHaveBeenCalledTimes(2)
  })

  it("keeps the previous SVG visible until a theme refresh succeeds", async () => {
    let finishDark: ((value: { svg: string }) => void) | undefined
    renderDiagram
      .mockResolvedValueOnce({ svg: '<svg viewBox="0 0 10 10"><text>Light</text></svg>' })
      .mockImplementationOnce(
        () =>
          new Promise<{ svg: string }>((resolve) => {
            finishDark = resolve
          }),
      )
    localStorage.setItem("morsel-theme", "light")
    render(
      <ThemeProvider>
        <MarkdownDocument content={"```mermaid\ngraph TD; A-->B\n```"} />
      </ThemeProvider>,
    )
    expect(await screen.findByText("Light")).toBeVisible()
    const user = userEvent.setup()
    await user.click(screen.getByRole("combobox", { name: "Theme" }))
    await user.click(screen.getByRole("option", { name: "Dark" }))
    await screen.findByText("Refreshing diagram theme…")
    expect(screen.getByText("Light")).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Download PNG" }))
    await waitFor(() =>
      expect(exportMock.createPngExport).toHaveBeenLastCalledWith(
        expect.any(SVGSVGElement),
        "light",
      ),
    )

    act(() => finishDark?.({ svg: '<svg viewBox="0 0 10 10"><text>Dark</text></svg>' }))
    expect(await screen.findByText("Dark")).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Download PNG" }))
    await waitFor(() =>
      expect(exportMock.createPngExport).toHaveBeenLastCalledWith(
        expect.any(SVGSVGElement),
        "dark",
      ),
    )
    expect(mermaidMock.configuration).toMatchObject({ theme: "dark" })
  })

  it("retains the previous SVG and retries a failed theme refresh", async () => {
    renderDiagram
      .mockResolvedValueOnce({ svg: '<svg viewBox="0 0 10 10"><text>Original</text></svg>' })
      .mockRejectedValueOnce(new Error("theme failed"))
      .mockResolvedValueOnce({ svg: '<svg viewBox="0 0 10 10"><text>Retried</text></svg>' })
    localStorage.setItem("morsel-theme", "light")
    render(
      <ThemeProvider>
        <MarkdownDocument content={"```mermaid\ngraph TD; A-->B\n```"} />
      </ThemeProvider>,
    )
    expect(await screen.findByText("Original")).toBeVisible()
    const user = userEvent.setup()
    await user.click(screen.getByRole("combobox", { name: "Theme" }))
    await user.click(screen.getByRole("option", { name: "Dark" }))
    expect(await screen.findByText("This Mermaid diagram could not be rendered.")).toBeVisible()
    expect(screen.getByText("Original")).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Retry diagram" }))
    expect(await screen.findByText("Retried")).toBeVisible()
  })

  it("discards a stale render after the source changes", async () => {
    let finishOld: ((value: { svg: string }) => void) | undefined
    let finishNew: ((value: { svg: string }) => void) | undefined
    renderDiagram
      .mockImplementationOnce(
        () =>
          new Promise<{ svg: string }>((resolve) => {
            finishOld = resolve
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<{ svg: string }>((resolve) => {
            finishNew = resolve
          }),
      )
    const { rerender } = render(
      <MarkdownDocument content={"```mermaid\ngraph TD; Old-->Result\n```"} />,
    )
    await waitFor(() => expect(renderDiagram).toHaveBeenCalledOnce())
    rerender(<MarkdownDocument content={"```mermaid\ngraph TD; New-->Result\n```"} />)
    await act(async () => finishOld?.({ svg: '<svg viewBox="0 0 10 10"><text>Old</text></svg>' }))
    await waitFor(() => expect(renderDiagram).toHaveBeenCalledTimes(2))
    expect(screen.queryByText("Old")).not.toBeInTheDocument()
    await act(async () => finishNew?.({ svg: '<svg viewBox="0 0 10 10"><text>New</text></svg>' }))
    expect(await screen.findByText("New")).toBeVisible()
  })

  it("isolates invalid, oversized, and excess Mermaid diagrams", async () => {
    renderDiagram.mockRejectedValueOnce(new Error("bad diagram"))
    const { rerender } = render(
      <MarkdownDocument content={"Before\n\n```mermaid\nbad\n```\n\nAfter"} />,
    )
    expect(
      await screen.findByText("This Mermaid diagram could not be rendered."),
    ).toBeInTheDocument()
    expect(screen.getByText("Before")).toBeInTheDocument()
    expect(screen.getByText("After")).toBeInTheDocument()

    rerender(<MarkdownDocument content={`\`\`\`mermaid\n${"x".repeat(50 * 1024 + 1)}\n\`\`\``} />)
    expect(screen.getByText("This diagram exceeds the 50 KiB source limit.")).toBeInTheDocument()

    const diagrams = Array.from(
      { length: 21 },
      (_, index) => `\`\`\`mermaid\ngraph TD; A${index}-->B\n\`\`\``,
    ).join("\n\n")
    rerender(<MarkdownDocument content={diagrams} />)
    expect(screen.getByText("Only the first 20 diagrams are rendered.")).toBeInTheDocument()
    await waitFor(() => expect(renderDiagram).toHaveBeenCalled())
  })
})
