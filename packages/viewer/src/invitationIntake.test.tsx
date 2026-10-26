import { act, fireEvent, render, screen } from "@testing-library/react"
import { StrictMode, useRef } from "react"
import { describe, expect, it, vi } from "vitest"
import { createInvitationIntake } from "./invitationIntake"
import { navigate, useAppLocation } from "./navigation"

const token = "A".repeat(43)
function Probe() {
  const intake = useRef<ReturnType<typeof createInvitationIntake> | null>(null)
  if (!intake.current) intake.current = createInvitationIntake()
  const location = useAppLocation(intake.current.capture, intake.current.clear)
  return (
    <>
      <output data-testid="location">{JSON.stringify(location)}</output>
      <output data-testid="intake">{intake.current.peek()}</output>
    </>
  )
}

describe("invitation fragment protocol prototype", () => {
  it.each([
    "#token=short",
    `#token=${"A".repeat(42)}B`,
    `#token=${token}&token=${token}`,
    `#token=${token}&extra=x`,
    `#other=${token}`,
    `#token=%41${token.slice(1)}`,
    "#token=%",
    `#token=${token}A`,
    `#token=${token.slice(1)}`,
    `#token=${token}=`,
  ])("rejects and scrubs a noncanonical fragment %s", (hash) => {
    window.history.replaceState({ unsupported: hash, morselIndex: 4 }, "", `/invite${hash}`)
    const intake = createInvitationIntake()
    expect(intake.capture()).toBe(1)
    expect(intake.peek()).toBe("")
    expect(window.location.hash).toBe("")
    expect(window.history.state).toEqual({ morselIndex: 4 })
  })

  it("extracts before the shared location snapshot and survives StrictMode initialization", () => {
    window.history.replaceState({}, "", `/invite#token=${token}`)
    render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    )
    expect(screen.getByTestId("intake")).toHaveTextContent(token)
    expect(screen.getByTestId("location")).not.toHaveTextContent(token)
    expect(window.location.hash).toBe("")
    expect(JSON.stringify(window.history.state)).not.toContain(token)
  })

  it("takes same-route hash and history arrivals without restoring or replaying their hash", () => {
    window.history.replaceState({}, "", "/invite")
    render(<Probe />)
    act(() => {
      window.history.pushState({ morselIndex: 1 }, "", `/invite#token=${token}`)
      fireEvent(window, new HashChangeEvent("hashchange"))
    })
    expect(screen.getByTestId("intake")).toHaveTextContent(token)
    expect(screen.getByTestId("location")).not.toHaveTextContent(token)
    expect(window.location.hash).toBe("")
    act(() => navigate("/"))
    expect(screen.getByTestId("intake")).toBeEmptyDOMElement()
    act(() => {
      window.history.replaceState({ morselIndex: 1 }, "", "/invite")
      fireEvent(window, new PopStateEvent("popstate"))
    })
    expect(screen.getByTestId("intake")).toBeEmptyDOMElement()
    expect(window.location.hash).toBe("")
  })

  it("never broadcasts an invitation fragment in programmatic navigation", () => {
    const listener = vi.fn()
    window.addEventListener("morsel:navigate", listener)
    try {
      navigate(`/invite#token=${token}`)
      expect(JSON.stringify(listener.mock.calls[0]?.[0].detail)).not.toContain(token)
    } finally {
      window.removeEventListener("morsel:navigate", listener)
    }
  })
})
