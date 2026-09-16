import { render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { MarkdownDocument } from "./MarkdownDocument"

const renderDiagram = vi.hoisted(() => vi.fn())
vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: renderDiagram,
  },
}))

beforeEach(() => {
  renderDiagram.mockReset()
  renderDiagram.mockResolvedValue({
    svg: '<svg viewBox="0 0 10 10"><title>Safe diagram</title><path d="M0 0" /></svg>',
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

![safe](https://images.example/a.png) ![bad](javascript:alert(1))

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
    expect(container.innerHTML).not.toMatch(/onerror|onload|<svg/i)
  })

  it("renders Mermaid sequentially and sanitizes returned SVG", async () => {
    renderDiagram.mockResolvedValueOnce({
      svg: '<svg onload="alert(1)"><script>alert(1)</script><foreignObject>bad</foreignObject><path d="M0 0" /></svg>',
    })
    const { container } = render(<MarkdownDocument content={"```mermaid\ngraph TD; A-->B\n```"} />)
    await screen.findByLabelText("Mermaid diagram")
    expect(renderDiagram).toHaveBeenCalledOnce()
    expect(container.querySelector("svg")).toBeInTheDocument()
    expect(container.innerHTML).not.toMatch(/onload|script|foreignObject/i)
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
