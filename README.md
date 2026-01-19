# LAPLACE Comet

A privacy-first desktop application for managing Bilibili private messages. Built with Electron, React, and TypeScript.

## Features

- **Secure Authentication** - Login via QR code scanning, with credentials encrypted using OS-level keychain
- **Multi-Account Support** - Manage multiple Bilibili accounts with easy switching
- **Real-Time Notifications** - Receive desktop notifications for new messages
- **Session Management** - View and manage all your private message conversations
- **Send Messages** - Reply to messages directly from the app
- **Dark Mode** - Automatic theme switching based on system preferences
- **Cross-Platform** - Available for Windows, macOS, and Linux

## Screenshots

*Coming soon*

## Installation

### Pre-built Releases

Download the latest release for your platform from the [Releases](https://github.com/laplace/laplace-comet/releases) page:

- **Windows**: `.exe` installer (Squirrel)
- **macOS**: `.zip` (signed and notarized)
- **Linux**: `.deb` or `.rpm` packages

### Build from Source

#### Prerequisites

- [Node.js](https://nodejs.org/) v22 or later
- [pnpm](https://pnpm.io/)

#### Steps

1. Clone the repository:
   ```bash
   git clone https://github.com/laplace/laplace-comet.git
   cd laplace-comet
   ```

2. Install dependencies:
   ```bash
   pnpm install
   ```

3. Start in development mode:
   ```bash
   pnpm start
   ```

4. Build distributable packages:
   ```bash
   pnpm make
   ```

   Built packages will be available in the `out/make` directory.

## Development

### Available Scripts

| Command | Description |
|---------|-------------|
| `pnpm start` | Start the app in development mode with hot reload |
| `pnpm package` | Package the app without creating installers |
| `pnpm make` | Create distributable packages for current platform |
| `pnpm lint` | Run ESLint on the codebase |
| `pnpm generate-icons` | Generate app icons for all platforms |

## Security

LAPLACE Comet prioritizes user privacy and security:

- **Local-Only Storage** - All credentials and data are stored locally on your device
- **OS-Level Encryption** - Sensitive credentials are encrypted using the operating system's secure storage (macOS Keychain, Windows Credential Store, Linux Secret Service)
- **No Analytics** - The app does not collect or transmit any usage data
- **Code Signed** - macOS and Windows releases are signed and notarized for authenticity

## Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.

1. Fork the repository
2. Create your feature branch (`git checkout -b feat/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feat/amazing-feature`)
5. Open a Pull Request

## Disclaimer

This is an unofficial third-party application and is not affiliated with, endorsed by, or sponsored by Bilibili. Use at your own risk and in accordance with Bilibili's terms of service.

## License

AGPL-3.0
