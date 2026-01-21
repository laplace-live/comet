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

<img width="559" height="791" alt="Screenshot 2026-01-20 at 6 36 40 PM" src="https://github.com/user-attachments/assets/71dc4035-8583-4e61-b438-27cdb89c86a4" />

## Installation

### Stable Releases

> [!IMPORTANT]
> All stable releases are signed and notarized. Do not download or run these from untrusted sources. If your system prompts that the app is from unknown sources without a signature, remove it immediately and report in our Discord.
>
> 所有稳定版本均已签名和公证。请勿从不受信任的来源下载或安装。如果系统提示该应用来自未知来源且未签名，请立即删除并在我们的 Discord 中报告。

Download the latest stable version from our GitHub releases:

[📦 Download Latest Release](https://github.com/laplace-live/comet/releases/latest)

Available for:

- **macOS**: `*.darwin-arm64-*.zip` package for Apple Silicon Macs
- **Windows**: `*.Setup.exe` installer for 64-bit systems

### Nightly Builds

Get the latest development builds with cutting-edge features:

[🌙 Download Nightly Builds](https://github.com/laplace-live/comet/actions)

1. Click on the latest workflow run with a ✅ status
2. Scroll down to "Artifacts" section
3. Download the build for your platform

> [!CAUTION]
> Nightly builds are automatically generated from the latest code and may contain experimental features or bugs. Use stable releases for production streaming.
>
> All nightly builds are not signed or notarized.

### Build from Source

#### Prerequisites

- [Node.js](https://nodejs.org/) v22 or later
- [pnpm](https://pnpm.io/)

#### Steps

1. Clone the repository:
   ```bash
   git clone https://github.com/laplace/laplace-comet
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

## Hall of Shame

See [Hall of Shame - Subspace Institute](https://subspace.institute/docs/shame)

## License

AGPL-3.0
