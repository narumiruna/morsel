import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderMermaid, sanitizeMermaidSVG } from "./mermaidRenderer"

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}))

vi.mock("mermaid", () => ({ default: mermaidMock }))

beforeEach(() => {
  mermaidMock.initialize.mockReset()
  mermaidMock.render.mockReset()
})

describe("Mermaid renderer", () => {
  it("serializes jobs and applies each requested theme", async () => {
    let finishFirst: ((value: { svg: string }) => void) | undefined
    mermaidMock.render
      .mockImplementationOnce(
        () =>
          new Promise<{ svg: string }>((resolve) => {
            finishFirst = resolve
          }),
      )
      .mockResolvedValueOnce({ svg: "<svg><text>second</text></svg>" })

    const first = renderMermaid("graph TD; A-->B", "light")
    const second = renderMermaid("graph TD; C-->D", "dark")
    await vi.waitFor(() => expect(mermaidMock.render).toHaveBeenCalledTimes(1))
    finishFirst?.({ svg: "<svg><text>first</text></svg>" })
    await expect(first).resolves.toContain("first")
    await expect(second).resolves.toContain("second")

    expect(mermaidMock.initialize.mock.calls[0]?.[0]).toMatchObject({
      htmlLabels: false,
      securityLevel: "strict",
      theme: "default",
    })
    expect(mermaidMock.initialize.mock.calls[1]?.[0]).toMatchObject({ theme: "dark" })
  })

  it("continues the queue after a rejected render", async () => {
    mermaidMock.render
      .mockRejectedValueOnce(new Error("bad diagram"))
      .mockResolvedValueOnce({ svg: "<svg><text>safe</text></svg>" })
    await expect(renderMermaid("bad", "light")).rejects.toThrow("bad diagram")
    await expect(renderMermaid("graph TD; A-->B", "light")).resolves.toContain("safe")
  })

  it("removes active content, foreign objects, and external links", () => {
    const sanitized = sanitizeMermaidSVG(
      '<svg onload="alert(1)"><style>.bad{fill:url(https://evil.invalid/pixel)}</style><script>alert(1)</script><foreignObject>bad</foreignObject><a href="https://evil.invalid"><text style="fill:url(https://evil.invalid/pixel)">safe</text></a><path marker-end="url(#arrow)" /></svg>',
    )
    expect(sanitized).toContain("safe")
    expect(sanitized).toContain("url(#arrow)")
    expect(sanitized).not.toMatch(/onload|script|foreignObject|https:\/\/evil/i)
  })
})
