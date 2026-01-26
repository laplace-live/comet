# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LAPLACE Comet is a privacy-first Electron desktop application for managing Bilibili private messages. Built with Electron + React 19 + TypeScript.

## Commands

```bash
pnpm start          # Start dev mode with hot reload
pnpm make           # Create distributable packages for current platform
pnpm package        # Package app without creating installers
pnpm lint           # Run ESLint
pnpm generate-icons # Generate app icons (uses bun)
```

## Architecture

### Process Model

- **Main Process** (`src/main.ts`): Electron main, handles IPC, native APIs, window management
- **Preload** (`src/preload.ts`): IPC bridge exposing `window.electronAPI` to renderer
- **Renderer** (`src/renderer.tsx`): React application entry point

### Key Directories

- `src/api/` - Bilibili API handlers (sessions, messages, DND, accounts) and WebSocket for real-time notifications
- `src/components/comet/` - Domain-specific components (login, sessions, messages, verification badges)
- `src/components/ui/` - Base UI components (headless, Tailwind-styled)
- `src/hooks/` - React hooks, notably `usePrivateMessages.ts` (main state management for multi-account, sessions, messages)
- `src/stores/` - Zustand stores for settings
- `src/lib/` - Shared utilities (`const.ts` for API constants/endpoints, `ipc.ts` for IPC contract, `utils.ts` for helpers)
- `src/types/` - Type definitions (`bilibili.ts` for API types, `electron.d.ts` for IPC types)

### State Management

- **Zustand** for app settings (`useSettings` store)
- **Custom hooks** for business logic (`usePrivateMessages` - manages sessions, messages, accounts, DND status)
- IPC calls via `window.electronAPI` for main process communication

### Session & Message Types

The app supports multiple session and message types defined in `src/lib/const.ts`:

- **SESSION_TYPE**: `USER` (1) for direct messages, `FAN_GROUP` (2) for fan group chats
- **MSG_TYPE**: Various message types including text, images, notifications, `AI_GENERATED` (52), `FAN_GROUP_SYSTEM` (306)
- **MSG_SOURCE**: Message origins including `AI` (19), `FAN_GROUP_SYSTEM` (13), auto-reply types, system tips

### Multi-Account Management

- Supports multiple Bilibili accounts with drag-and-drop reordering (@dnd-kit)
- Account operations: add, remove, re-authenticate, reorder, set active
- Per-account DND (Do Not Disturb) toggle for both user and fan group sessions

### API Pattern

Renderer calls main process via IPC using a centralized contract:
```typescript
// Renderer (via preload bridge)
const result = await window.electronAPI.bilibili.fetchSessions(params)

// Main process handler (src/api/bilibili.ts)
ipcMain.handle(IpcChannel.BILIBILI_FETCH_SESSIONS, async (event, params) => { ... })

// IPC channels and types defined in src/lib/ipc.ts
```

The IPC system uses:
- `IpcChannel` - Constants for invoke channels (renderer → main → response)
- `IpcEvent` - Constants for event channels (main → renderer, one-way)
- `IpcInvokeContract` / `IpcEventContract` - Type mappings for all channels

## Code Conventions

- **Import alias**: `@/` maps to `./src/`
- **Formatting**: Biome (2-space indent, single quotes, no semicolons, 120 char line width)
- **Import ordering**: Biome organizes imports by groups (node/packages, types, components, etc.)
- **Tailwind class sorting**: Use `cn()` from `@/lib/utils` for conditional classes (Biome auto-sorts)

## Important Files

- `forge.config.ts` - Electron Forge build configuration
- `vite.main.config.ts` / `vite.renderer.config.ts` - Vite configs for each process
- `src/lib/const.ts` - Centralized constants (MSG_TYPE, MSG_SOURCE, SESSION_TYPE, image formats, API endpoints)
- `src/lib/ipc.ts` - IPC contract (channel names and type definitions for all IPC communication)
- `src/types/bilibili.ts` - API response types (reference when working with Bilibili data)
- `src/types/electron.d.ts` - ElectronAPI interface and IPC parameter/result types

### Key Components

- `src/components/comet/MessageBubble.tsx` - Message rendering with support for text, images, AI messages, fan group system messages, auto-replies
- `src/components/comet/MessagesList.tsx` - Virtualized message list with sender identification for fan groups
- `src/components/comet/SessionItem.tsx` - Session list item with verification badge and DND toggle
- `src/components/comet/VerifiedBadge.tsx` - User verification status indicator with color coding
- `src/hooks/usePrivateMessages.ts` - Main state management hook for sessions, messages, multi-account, and DND
