'use client'

import * as ResizablePrimitive from 'react-resizable-panels'

import { cn } from '@/lib/utils'

// Group applies its own inline flex layout (direction, 100% width/height), so it needs no default classes
const ResizablePanelGroup = ResizablePrimitive.Group

const ResizablePanel = ResizablePrimitive.Panel

const ResizableHandle = ({
  withHandle,
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.Separator> & {
  withHandle?: boolean
}) => (
  <ResizablePrimitive.Separator
    className={cn(
      // Hit area comes from the library (Group `resizeTargetMinimumSize`), so no ::after extension
      'flex w-px items-center justify-center bg-fg/20',

      // Hover state
      'data-[separator=hover]:bg-ac/60 data-[separator=hover]:[&>[data-slot=handle]]:border-ac/60 data-[separator=hover]:[&>[data-slot=handle]]:bg-ac/20 data-[separator=hover]:[&>[data-slot=handle]]:backdrop-blur-sm',

      // Drag state
      'data-[separator=active]:bg-ac data-[separator=active]:[&>[data-slot=handle]]:border-ac data-[separator=active]:[&>[data-slot=handle]]:bg-ac data-[separator=active]:[&>[data-slot=handle]]:text-fg',

      // Focus state
      'focus-visible:bg-ac focus-visible:outline-none focus-visible:[&>[data-slot=handle]]:border-ac focus-visible:[&>[data-slot=handle]]:bg-ac/20 focus-visible:[&>[data-slot=handle]]:text-ac focus-visible:[&>[data-slot=handle]]:backdrop-blur-sm',

      // Vertical group (separator orientation is perpendicular to the group, so it reports as horizontal)
      'aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full [&[aria-orientation=horizontal]>[data-slot=handle]]:rotate-90',
      className
    )}
    {...props}
  >
    {withHandle && (
      <div
        data-slot='handle'
        className='z-10 flex h-6 w-2 items-center justify-center rounded-sm border bg-bg text-fg/30'
      >
        <div className='h-6 w-2' />
      </div>
    )}
  </ResizablePrimitive.Separator>
)

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }
