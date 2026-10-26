// This object belongs to one mounted invitation flow, never to a global store.
export function createInvitationIntake() {
  let token = ""
  let revision = 0
  return {
    capture(arrival = false) {
      if (window.location.pathname !== "/invite") {
        token = ""
        return revision
      }
      if (!window.location.hash && !window.location.href.endsWith("#")) {
        if (arrival) {
          token = ""
          revision += 1
        }
        return revision
      }
      // Accept only the canonical, unescaped single field. Do not decode secrets.
      const match = /^#token=([A-Za-z0-9_-]{42}[AEIMQUYcgkosw048])$/.exec(window.location.hash)
      token = match?.[1] ?? ""
      revision += 1
      const index: unknown = window.history.state?.morselIndex
      // Retain only the router's supported non-secret state.
      window.history.replaceState(
        Number.isSafeInteger(index) ? { morselIndex: index } : {},
        "",
        window.location.pathname + window.location.search,
      )
      return revision
    },
    peek: () => token,
    clear() {
      token = ""
    },
  }
}
export type InvitationIntake = ReturnType<typeof createInvitationIntake>
