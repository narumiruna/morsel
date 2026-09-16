import * as Tooltip from "@radix-ui/react-tooltip"
import { Button } from "@radix-ui/themes"
import type { ComponentProps, ReactNode } from "react"

export function ActionButton({
  label,
  children,
  tooltipContainer,
  ...props
}: {
  label: string
  children: ReactNode
  tooltipContainer?: Element | DocumentFragment | null
} & ComponentProps<typeof Button>) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <Button aria-label={label} {...props}>
          {children}
        </Button>
      </Tooltip.Trigger>
      <Tooltip.Portal container={tooltipContainer}>
        <Tooltip.Content className="tooltip" sideOffset={6}>
          {label}
          <Tooltip.Arrow className="tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}
