import { createContext, type ReactNode, useContext, useState } from "react"

export type MermaidLook = "classic" | "handDrawn"

const storageKey = "morsel-mermaid-look"
const MermaidLookContext = createContext<{
  look: MermaidLook | undefined
  updateLook: (look: MermaidLook | undefined) => void
}>({ look: undefined, updateLook: () => {} })

function initialLook(): MermaidLook | undefined {
  try {
    const stored = localStorage.getItem(storageKey)
    if (stored === "classic" || stored === "handDrawn") return stored
  } catch {
    // Use the source style when storage is unavailable.
  }
  return undefined
}

export function useMermaidLook() {
  return useContext(MermaidLookContext)
}

export function MermaidLookProvider({ children }: { children: ReactNode }) {
  const [look, setLook] = useState(initialLook)

  function updateLook(next: MermaidLook | undefined) {
    try {
      if (next) localStorage.setItem(storageKey, next)
      else localStorage.removeItem(storageKey)
    } catch {
      // The choice still applies to this session when storage is unavailable.
    }
    setLook(next)
  }

  return (
    <MermaidLookContext.Provider value={{ look, updateLook }}>
      {children}
    </MermaidLookContext.Provider>
  )
}
