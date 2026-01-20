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

- `src/api/` - Bilibili API handlers and WebSocket for real-time notifications
- `src/components/comet/` - Domain-specific components (login, sessions, messages)
- `src/components/ui/` - Base UI components (headless, Tailwind-styled)
- `src/hooks/` - React hooks, notably `usePrivateMessages.ts` (main state management)
- `src/stores/` - Zustand stores for settings
- `src/lib/const.ts` - API endpoints, headers, image MIME types
- `src/types/bilibili.ts` - Comprehensive Bilibili API type definitions

### State Management

- **Zustand** for app settings (`useSettings` store)
- **Custom hooks** for business logic (`usePrivateMessages` - manages sessions, messages, accounts)
- IPC calls via `window.electronAPI` for main process communication

### API Pattern

Renderer calls main process via IPC:
```typescript
// Renderer
const result = await window.electronAPI.someApiCall(params)

// Main (src/api/bilibili.ts)
ipcMain.handle('some-api-call', async (event, params) => { ... })
```

## Code Conventions

- **Import alias**: `@/` maps to `./src/`
- **Formatting**: Biome (2-space indent, single quotes, no semicolons, 120 char line width)
- **Import ordering**: Biome organizes imports by groups (node/packages, types, components, etc.)
- **Tailwind class sorting**: Use `cn()` from `@/lib/utils` for conditional classes (Biome auto-sorts)

## Important Files

- `forge.config.ts` - Electron Forge build configuration
- `vite.main.config.ts` / `vite.renderer.config.ts` - Vite configs for each process
- `src/lib/const.ts` - Centralized constants (MSG_TYPE, SESSION_TYPE, allowed image formats)
- `src/types/bilibili.ts` - API response types (reference when working with Bilibili data)
