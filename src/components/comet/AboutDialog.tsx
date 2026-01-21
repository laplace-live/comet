import { useCallback, useEffect, useState } from 'react'

import type { UpdateStatusInfo } from '@/types/electron'

import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { Separator } from '@/components/ui/separator'

import appLogo from '@/assets/logo.svg'
import { useSettings } from '@/stores/useSettings'

export function AboutDialog() {
  const { aboutOpen, openAbout, closeAbout } = useSettings()
  const [version, setVersion] = useState<string>('')
  const [updateStatus, setUpdateStatus] = useState<UpdateStatusInfo>({ status: 'idle' })
  const [isChecking, setIsChecking] = useState(false)

  useEffect(() => {
    window.electronAPI.getVersion().then(setVersion)

    // Listen for update status changes
    const cleanup = window.electronAPI.onUpdateStatus(status => {
      setUpdateStatus(status)
      if (status.status !== 'checking') {
        setIsChecking(false)
      }
    })

    return cleanup
  }, [])

  const handleCheckForUpdates = useCallback(async () => {
    setIsChecking(true)
    await window.electronAPI.checkForUpdates()
  }, [])

  const getUpdateStatusText = () => {
    switch (updateStatus.status) {
      case 'checking':
        return '正在检查更新...'
      case 'available':
        return '有新版本可用，正在下载...'
      case 'downloaded':
        return updateStatus.version ? `新版本 ${updateStatus.version} 已下载，重启后生效` : '更新已下载，重启后生效'
      case 'not-available':
        return '已是最新版本'
      case 'error':
        return updateStatus.error ? `检查更新失败: ${updateStatus.error}` : '检查更新失败'
      default:
        return null
    }
  }

  const updateStatusText = getUpdateStatusText()

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
              <img src={appLogo} alt='LAPLACE Comet' width={64} height={64} className='size-16' />
              <div className='space-y-1 text-center'>
                <h3 className='font-bold font-logo text-3xl'>LAPLACE Comet</h3>
                <p className='text-muted-foreground'>Privacy-first Bilibili PM Manager</p>
                <p className='text-muted-foreground text-sm'>
                  Version <span className='select-text'>{version}</span> ·{' '}
                  <a href='https://github.com/laplace-live/comet' target='_blank' rel='noopener noreferrer'>
                    Source
                  </a>
                </p>

                {updateStatusText && <p className='text-muted-foreground text-sm'>{updateStatusText}</p>}

                <Button
                  variant='outline'
                  size='sm'
                  onClick={handleCheckForUpdates}
                  disabled={isChecking}
                  className='mt-2'
                >
                  {isChecking ? '检查中...' : '检查更新'}
                </Button>
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
