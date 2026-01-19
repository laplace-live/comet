'use client'

import { ContextMenu as ContextMenuPrimitive } from '@base-ui/react/context-menu'
import { ChevronRightIcon } from 'lucide-react'
import type * as React from 'react'

import { cn } from '@/lib/utils'

const ContextMenu = ContextMenuPrimitive.Root

const ContextMenuPortal = ContextMenuPrimitive.Portal

function ContextMenuTrigger(props: ContextMenuPrimitive.Trigger.Props) {
  return <ContextMenuPrimitive.Trigger data-slot='context-menu-trigger' {...props} />
}

function ContextMenuPopup({
  children,
  className,
  sideOffset = 4,
  align = 'start',
  alignOffset,
  side = 'bottom',
  ...props
}: ContextMenuPrimitive.Popup.Props & {
  align?: ContextMenuPrimitive.Positioner.Props['align']
  sideOffset?: ContextMenuPrimitive.Positioner.Props['sideOffset']
  alignOffset?: ContextMenuPrimitive.Positioner.Props['alignOffset']
  side?: ContextMenuPrimitive.Positioner.Props['side']
}) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        className='z-50'
        data-slot='context-menu-positioner'
        side={side}
        sideOffset={sideOffset}
      >
        <ContextMenuPrimitive.Popup
          className={cn(
            "relative flex not-[class*='w-']:min-w-32 origin-(--transform-origin) rounded-lg border bg-popover bg-clip-padding shadow-lg outline-none transition-[scale,opacity] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] focus:outline-none has-data-starting-style:scale-98 has-data-starting-style:opacity-0 dark:bg-clip-border dark:before:shadow-[0_-1px_--theme(--color-white/8%)]",
            className
          )}
          data-slot='context-menu-popup'
          {...props}
        >
          <div className='max-h-(--available-height) w-full overflow-y-auto p-1'>{children}</div>
        </ContextMenuPrimitive.Popup>
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  )
}

function ContextMenuGroup(props: ContextMenuPrimitive.Group.Props) {
  return <ContextMenuPrimitive.Group data-slot='context-menu-group' {...props} />
}

function ContextMenuItem({
  className,
  inset,
  variant = 'default',
  ...props
}: ContextMenuPrimitive.Item.Props & {
  inset?: boolean
  variant?: 'default' | 'destructive'
}) {
  return (
    <ContextMenuPrimitive.Item
      className={cn(
        "flex min-h-8 cursor-default select-none items-center gap-2 rounded-sm px-2 py-1 text-base outline-none data-disabled:pointer-events-none data-highlighted:bg-accent data-inset:ps-8 data-[variant=destructive]:text-destructive-foreground data-highlighted:text-accent-foreground data-disabled:opacity-64 sm:min-h-7 sm:text-sm [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:-mx-0.5 [&_svg]:shrink-0",
        className
      )}
      data-inset={inset}
      data-slot='context-menu-item'
      data-variant={variant}
      {...props}
    />
  )
}

function ContextMenuCheckboxItem({ className, children, checked, ...props }: ContextMenuPrimitive.CheckboxItem.Props) {
  return (
    <ContextMenuPrimitive.CheckboxItem
      checked={checked}
      className={cn(
        "grid min-h-8 in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] cursor-default grid-cols-[1rem_1fr] items-center gap-2 rounded-sm py-1 ps-2 pe-4 text-base outline-none data-disabled:pointer-events-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:opacity-64 sm:min-h-7 sm:text-sm [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className
      )}
      data-slot='context-menu-checkbox-item'
      {...props}
    >
      <ContextMenuPrimitive.CheckboxItemIndicator className='col-start-1'>
        <svg
          aria-hidden='true'
          fill='none'
          height='24'
          stroke='currentColor'
          strokeLinecap='round'
          strokeLinejoin='round'
          strokeWidth='2'
          viewBox='0 0 24 24'
          width='24'
          xmlns='http://www.w3.org/2000/svg'
        >
          <path d='M5.252 12.7 10.2 18.63 18.748 5.37' />
        </svg>
      </ContextMenuPrimitive.CheckboxItemIndicator>
      <span className='col-start-2'>{children}</span>
    </ContextMenuPrimitive.CheckboxItem>
  )
}

function ContextMenuRadioGroup(props: ContextMenuPrimitive.RadioGroup.Props) {
  return <ContextMenuPrimitive.RadioGroup data-slot='context-menu-radio-group' {...props} />
}

function ContextMenuRadioItem({ className, children, ...props }: ContextMenuPrimitive.RadioItem.Props) {
  return (
    <ContextMenuPrimitive.RadioItem
      className={cn(
        "grid min-h-8 in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] cursor-default grid-cols-[1rem_1fr] items-center gap-2 rounded-sm py-1 ps-2 pe-4 text-base outline-none data-disabled:pointer-events-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:opacity-64 sm:min-h-7 sm:text-sm [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className
      )}
      data-slot='context-menu-radio-item'
      {...props}
    >
      <ContextMenuPrimitive.RadioItemIndicator className='col-start-1'>
        <svg
          aria-hidden='true'
          fill='none'
          height='24'
          stroke='currentColor'
          strokeLinecap='round'
          strokeLinejoin='round'
          strokeWidth='2'
          viewBox='0 0 24 24'
          width='24'
          xmlns='http://www.w3.org/2000/svg'
        >
          <path d='M5.252 12.7 10.2 18.63 18.748 5.37' />
        </svg>
      </ContextMenuPrimitive.RadioItemIndicator>
      <span className='col-start-2'>{children}</span>
    </ContextMenuPrimitive.RadioItem>
  )
}

function ContextMenuGroupLabel({
  className,
  inset,
  ...props
}: ContextMenuPrimitive.GroupLabel.Props & {
  inset?: boolean
}) {
  return (
    <ContextMenuPrimitive.GroupLabel
      className={cn(
        'px-2 py-1.5 font-medium text-muted-foreground text-xs data-inset:ps-9 sm:data-inset:ps-8',
        className
      )}
      data-inset={inset}
      data-slot='context-menu-label'
      {...props}
    />
  )
}

function ContextMenuSeparator({ className, ...props }: ContextMenuPrimitive.Separator.Props) {
  return (
    <ContextMenuPrimitive.Separator
      className={cn('mx-2 my-1 h-px bg-border', className)}
      data-slot='context-menu-separator'
      {...props}
    />
  )
}

function ContextMenuShortcut({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      className={cn('ms-auto font-medium text-muted-foreground/72 text-xs tracking-widest', className)}
      data-slot='context-menu-shortcut'
      {...props}
    />
  )
}

function ContextMenuSub(props: ContextMenuPrimitive.SubmenuRoot.Props) {
  return <ContextMenuPrimitive.SubmenuRoot data-slot='context-menu-sub' {...props} />
}

function ContextMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: ContextMenuPrimitive.SubmenuTrigger.Props & {
  inset?: boolean
}) {
  return (
    <ContextMenuPrimitive.SubmenuTrigger
      className={cn(
        "flex min-h-8 items-center gap-2 rounded-sm px-2 py-1 text-base outline-none data-disabled:pointer-events-none data-highlighted:bg-accent data-popup-open:bg-accent data-inset:ps-8 data-highlighted:text-accent-foreground data-popup-open:text-accent-foreground data-disabled:opacity-64 sm:min-h-7 sm:text-sm [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none",
        className
      )}
      data-inset={inset}
      data-slot='context-menu-sub-trigger'
      {...props}
    >
      {children}
      <ChevronRightIcon className='ms-auto -me-0.5 opacity-80' />
    </ContextMenuPrimitive.SubmenuTrigger>
  )
}

function ContextMenuSubPopup({
  className,
  sideOffset = 0,
  alignOffset,
  align = 'start',
  ...props
}: ContextMenuPrimitive.Popup.Props & {
  align?: ContextMenuPrimitive.Positioner.Props['align']
  sideOffset?: ContextMenuPrimitive.Positioner.Props['sideOffset']
  alignOffset?: ContextMenuPrimitive.Positioner.Props['alignOffset']
}) {
  const defaultAlignOffset = align !== 'center' ? -5 : undefined

  return (
    <ContextMenuPopup
      align={align}
      alignOffset={alignOffset ?? defaultAlignOffset}
      className={className}
      data-slot='context-menu-sub-content'
      side='inline-end'
      sideOffset={sideOffset}
      {...props}
    />
  )
}

export {
  ContextMenu,
  ContextMenuPortal,
  ContextMenuTrigger,
  ContextMenuPopup,
  ContextMenuPopup as ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuGroupLabel,
  ContextMenuGroupLabel as ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubPopup,
  ContextMenuSubPopup as ContextMenuSubContent,
}
