# Hermes Forge Release Checklist

This checklist is for small stability releases such as v0.1.3. Do not include local secrets, `.env`, user-data, logs, snapshots, or private paths in release notes.

## Command Checks

Run these from the repository root:

```powershell
npm run check
npm test
npm run build
npm run package:portable
```

## Manual Acceptance

- Launch the client from the packaged app.
- Confirm the chat input shows model, workspace, and permission status.
- Configure a model source, test the connection, then save it as default.
- Send 5 normal text tasks in one session and confirm each reaches a final result.
- Create a second session, send 2-3 tasks, then switch back and confirm history does not mix.
- Quit and reopen the app, then confirm recent session history is restored.
- Upload one file or image attachment and send a task with it.
- Trigger an approval flow and test both allow and deny.
- Export diagnostics from the app and confirm the output path is shown.

## Release Notes Minimum

- Version number and date.
- User-facing fixes.
- Known limitations.
- Any manual verification completed.
