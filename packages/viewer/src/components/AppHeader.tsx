import { DropdownMenu } from "@radix-ui/themes"
import "../styles/shell.css"

export function AppHeader({
  authenticated = false,
  busy = false,
  onLogout,
  displayName,
  activeSection,
}: {
  activeSection?: "shares" | "settings"
  displayName?: string
  authenticated?: boolean
  busy?: boolean
  onLogout?: () => void
}) {
  return (
    <header className="app-header">
      <a className="app-brand" href="/" aria-label="Morsel home">
        Morsel
      </a>
      <nav aria-label="Main navigation">
        <a href="/manage/shares" aria-current={activeSection === "shares" ? "page" : undefined}>
          Shares
        </a>
        <a href="/settings" aria-current={activeSection === "settings" ? "page" : undefined}>
          Settings
        </a>
      </nav>
      <div className="app-header-controls">
        {authenticated && (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              <button type="button" className="account-menu-trigger" aria-label="Account">
                Account
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content>
              {displayName && <DropdownMenu.Label>{displayName}</DropdownMenu.Label>}
              <DropdownMenu.Item asChild>
                <a href="/account">Account security</a>
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item disabled={busy} onSelect={onLogout}>
                Log out
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        )}
      </div>
    </header>
  )
}
