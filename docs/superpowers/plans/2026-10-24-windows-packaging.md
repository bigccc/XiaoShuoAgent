# Windows x64 packaging implementation plan

**Goal:** Deliver a Windows x64 installer and portable ZIP for 小说工坊.

**Architecture:** Keep Electron Forge, add Squirrel.Windows and enable ZIP for win32. Handle installer lifecycle before initializing application data; keep macOS window controls and use native Windows chrome. Use Ctrl shortcuts on Windows.

**Tech Stack:** Electron 44.5.1, Electron Forge 8, React, Playwright.

**Spec:** User approved Windows x64 packaging, platform adaptation and verification in this chat (2026-10-24). No public release requested.

## Constraints and review focus

- Keep current macOS packaging and user data untouched.
- Installer maintenance must exit without opening a window or creating a database.
- Windows titlebar must retain close/minimize/maximize controls.
- Ctrl save/navigation must preserve unsaved-edit protection and IME behavior.
- Verify Chinese paths, persistence, export and a loopback AI connection using isolated fixtures.
- Record Windows ARM x64 emulation separately from native x64 verification; no signing claim.

## Steps

- [x] Add Windows maker and metadata in forge.config.mjs, locked dependencies and explicit Windows build commands in package.json.
- [x] Reproduce Ctrl shortcut failure in a real renderer, then adapt modifier handling, shortcut labels and platform titlebar; guard Squirrel maintenance startup.
- [x] Build ZIP and installer in the local Windows VM using a separate copied workspace and portable Node; run type checking, unit suite and packaged smoke/keyboard workflows.
- [x] Test silent installation, installed launch and uninstall in the VM; inspect artifact contents and generate SHA-256 checksums.
- [x] Document commands, installation, platform coverage and remaining limitations; return the actual artifacts.

Validation details and the partial uninstall cleanup limitation are recorded in `docs/windows.md`.
