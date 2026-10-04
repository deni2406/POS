# Copilot instructions

## Project overview

This repository contains a billiards POS application. The primary backend is a
single Node.js HTTPS server in `server.js`; it serves the cashier web UI, handles
API routes, and coordinates SQLite and table-light hardware. The frontend is mostly plain HTML, CSS, and JavaScript.
The Android application is a Capacitor WebView client for the POS server.

## Main files and modules

- `server.js`: backend entry point, HTTPS routes, SQLite schema setup/migrations,
  cashier/session handling, transactions, table sessions, stock opname, and
  lamp watchdog logic.
- `pos.db`: local SQLite database. Schema is created and incrementally migrated
  by `server.js`; inspect its migrations before changing queries or data shapes.
- `index.html`: primary web POS UI and much of its application logic.
- `style.css`, `pos.css`, `meja.css`, `waitinglist.css`, and
  `stock-opname.css`: UI styles.
- `meja-modal.js`, `meja-timer.js`, `meja-bubble.js`,
  `meja-produk-modal.js`, `pricing-meja.js`, and `promo.js`: table workflows,
  timer/display behavior, and pricing.
- `member.js`, `waitinglist.js`, and `waitinglist-api.js`: member and booking
  flows.
- `stock-opname.js`: stock-opname UI and server/API coordination.
- `www/printer-bluetooth.js` and `printer-pesanan.js`: ESC/POS Bluetooth
  receipt and BAR/DAPUR order printing.
- `config.js`: server configuration; manager TOTP secret is supplied through
  the process environment. Catalog and member prices are read from SQLite.
- `PBMS-GAS-MIGRATION.md`: current GAS migration scope, disabled legacy
  Stock Opname behavior, database audit, and remaining manual verification.
- `lamp-controlle/lamp-controller.js`: serial lamp controller; its package
  declares `serialport`.
- `capacitor.config.json` and `android/`: Capacitor and native Android wrapper.

## Implementation guidance

- Follow existing CommonJS conventions in Node modules and existing browser
  JavaScript conventions in frontend modules. `server.js` uses Node's built-in
  `https` server and explicit route checks; do not assume Express or introduce a
  framework for a small route change.
- Preserve API request/response shapes used by the frontend. Authenticated
  requests generally carry `X-Session-Id` and `X-Device-Id`; use
  `authenticatedFetch()` in `index.html` or follow the relevant module's
  established auth-header helper.
- Keep business-critical transaction, shift, and table-session state on the
  server/database. Do not treat browser state as the source of truth for a
  persisted table session.
- Table pricing has separate paths: `pricing-meja.js` and `promo.js` handle
  non-member pricing locally, while member pricing is obtained from the backend.
  Preserve the distinction and existing LOSS-session billing behavior.
- The frontend and native app are coupled to the configured POS server URL.
  Check both `capacitor.config.json` and Android's `MainActivity.java` before
  changing server connectivity or WebView behavior. Network trust configuration
  is under `android/app/src/main/res/xml/`.
- Printer access is a native Capacitor plugin integration, not a server-side
  printer API. Preserve plugin use and the separate receipt versus BAR/DAPUR
  ticket flows.
- Lamp commands are issued by the backend through
  `lamp-controlle/lamp-controller.js`; the frontend displays watchdog alarms.
  Hardware serial settings are currently defined in that module. Keep hardware
  operations serialized and do not move them into browser code.
- Treat credentials, signing material, certificates, databases, APKs, and
  backups as sensitive or generated data. Never add secrets to source or
  documentation. Do not use backup copies as the source of truth without
  confirming their purpose.
- The repository may contain local changes and historical backup files. Inspect
  `git status` and the exact target files before editing; do not overwrite or
  revert unrelated work. Avoid broad formatting or synchronization of duplicate
  web assets unless the intended source of truth is established.

## Validation

- Inspect `package.json` before choosing commands; it may not define build or
  test scripts. There is a separate `lamp-controlle/package.json`.
- Run the narrowest relevant existing test or check. Do not assume a full suite
  exists, and do not run hardware-dependent lamp or printer operations unless
  explicitly requested and safe.
- For Android changes, use the repository's Gradle wrapper and validate the
  relevant Android build when the environment supports it.
