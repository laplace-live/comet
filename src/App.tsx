import { useCallback, useEffect, useState } from 'react'

import { usePrivateMessages } from '@/hooks/usePrivateMessages'

import { AddAccountDialog, LoginScreen, MessagesPanel, SessionList } from '@/components/comet'

export default function App() {
  const {
    sessions,
    selectedSession,
    messages,
    emojiInfoMap,
    loading,
    loadingMore,
    messagesLoading,
    sendingMessage,
    isConnected,
    userCache,
    hasMoreSessions,
    userInfo,
    // Multi-account state
    accounts,
    activeAccountMid,
    isAddingAccount,
    reauthAccount,
    // Actions
    checkLogin,
    logout,
    fetchSessions,
    loadMoreSessions,
    selectSession,
    clearSelectedSession,
    sendMessage,
    sendImageMessage,
    recallMessage,
    // Multi-account actions
    switchAccount,
    removeAccount,
    startAddingAccount,
    cancelAddingAccount,
    onAccountAdded,
    startReauthAccount,
    cancelReauthAccount,
    onReauthSuccess,
  } = usePrivateMessages()

  const [initialLoading, setInitialLoading] = useState(true)

  // Check login on mount
  useEffect(() => {
    const init = async () => {
      await checkLogin()
      setInitialLoading(false)
    }
    init()
  }, [checkLogin])

  // Fetch sessions when connected
  useEffect(() => {
    if (isConnected && !initialLoading) {
      fetchSessions()
    }
  }, [isConnected, initialLoading, fetchSessions])

  const handleLoginSuccess = useCallback(async () => {
    await checkLogin()
    fetchSessions()
  }, [checkLogin, fetchSessions])

  // Show loading state while checking initial login
  if (initialLoading) {
    return (
      <div className='flex h-screen flex-col bg-linear-to-br from-slate-50 via-zinc-50 to-stone-100 font-sans dark:from-zinc-950 dark:via-neutral-950 dark:to-stone-950'>
        <div className='flex flex-1 items-center justify-center'>
          <div className='size-8 animate-spin rounded-full border-4 border-pink-500 border-t-transparent' />
        </div>
      </div>
    )
  }

  return (
    <div className='flex h-screen bg-linear-to-br from-slate-50 via-zinc-50 to-stone-100 font-sans dark:from-zinc-950 dark:via-neutral-950 dark:to-stone-950'>
      {!isConnected ? (
        <LoginScreen onLoginSuccess={handleLoginSuccess} />
      ) : (
        <>
          <SessionList
            sessions={sessions}
            selectedSession={selectedSession}
            loading={loading}
            loadingMore={loadingMore}
            hasMoreSessions={hasMoreSessions}
            isHidden={!!selectedSession}
            isConnected={isConnected}
            userCache={userCache}
            userInfo={userInfo}
            accounts={accounts}
            activeAccountMid={activeAccountMid}
            onSessionClick={selectSession}
            onLoadMore={loadMoreSessions}
            onRefresh={fetchSessions}
            onLogout={logout}
            onSwitchAccount={switchAccount}
            onAddAccount={startAddingAccount}
            onRemoveAccount={removeAccount}
            onReauthAccount={startReauthAccount}
          />

          <MessagesPanel
            selectedSession={selectedSession}
            messages={messages}
            emojiInfoMap={emojiInfoMap}
            messagesLoading={messagesLoading}
            sendingMessage={sendingMessage}
            isVisible={!!selectedSession}
            userCache={userCache}
            userInfo={userInfo}
            onBack={clearSelectedSession}
            onSendMessage={sendMessage}
            onSendImage={sendImageMessage}
            onRecall={recallMessage}
          />

          {/* Add Account / Re-auth Dialog */}
          <AddAccountDialog
            open={isAddingAccount}
            onOpenChange={open => {
              if (!open) {
                if (reauthAccount) {
                  cancelReauthAccount()
                } else {
                  cancelAddingAccount()
                }
              }
            }}
            onSuccess={reauthAccount ? onReauthSuccess : onAccountAdded}
            reauthAccount={reauthAccount}
          />
        </>
      )}
    </div>
  )
}
