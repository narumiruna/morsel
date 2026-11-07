import "../styles/shell.css"

const sections = [
  { section: "preferences", href: "/settings", label: "Appearance" },
  { section: "api-keys", href: "/manage/api-keys", label: "API keys" },
  { section: "security", href: "/account", label: "Security" },
  { section: "invitations", href: "/manage/invitations", label: "Invitations" },
] as const

export function SettingsNavigation({
  section,
  isAdmin = false,
}: {
  section: (typeof sections)[number]["section"]
  isAdmin?: boolean
}) {
  return (
    <nav className="settings-navigation" aria-label="Settings sections">
      {sections
        .filter((item) => item.section !== "invitations" || isAdmin)
        .map((item) => (
          <a
            key={item.section}
            href={item.href}
            aria-current={section === item.section ? "page" : undefined}
          >
            {item.label}
          </a>
        ))}
    </nav>
  )
}
