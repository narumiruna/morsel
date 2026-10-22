import { DropdownMenu } from "@radix-ui/themes"
import { ThemeControl } from "../theme"
import "../styles/shell.css"

export function AppHeader({
  authenticated = false,
  busy = false,
  onLogout,
}: {
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
        <a href="/manage/shares">Manage</a>
      </nav>
      <div className="app-header-controls">
        <ThemeControl />
        {authenticated && (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              <button type="button" className="account-menu-trigger">
                Account
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content>
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
