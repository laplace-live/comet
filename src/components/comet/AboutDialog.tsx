import { useEffect, useState } from 'react'

import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { Separator } from '@/components/ui/separator'

import appIcon from '@/assets/icon.png'
import { useSettings } from '@/stores/useSettings'

export function AboutDialog() {
  const { aboutOpen, openAbout, closeAbout } = useSettings()
  const [version, setVersion] = useState<string>('')

  useEffect(() => {
    window.electronAPI.getVersion().then(setVersion)
  }, [])

  return (
    <Dialog open={aboutOpen} onOpenChange={open => (open ? openAbout() : closeAbout())}>
      <DialogPopup className='max-w-sm'>
        <DialogHeader className='sr-only'>
          <DialogTitle>关于 LAPLACE Comet</DialogTitle>
          <DialogDescription>应用程序信息</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className='mt-10 select-none space-y-4'>
            <div className='flex flex-col items-center gap-2'>
              <img src={appIcon} alt='LAPLACE Comet' className='size-16' />
              <div className='space-y-1 text-center'>
                <h3 className='font-bold font-logo text-3xl'>LAPLACE Comet</h3>
                <p className='text-muted-foreground'>Privacy-first Bilibili PM Manager</p>
                <p className='text-muted-foreground text-sm'>
                  Version <span className='select-text'>{version}</span>
                </p>
              </div>
            </div>

            <Separator />

            <div className='flex flex-col items-center'>
              <p className='text-muted-foreground text-sm'>Tech otakus destroy the world</p>
              <a
                href='https://laplace.live'
                target='_blank'
                rel='noopener noreferrer'
                className='font-logo font-semibold text-primary hover:underline'
              >
                LAPLACE
              </a>
            </div>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  )
}
