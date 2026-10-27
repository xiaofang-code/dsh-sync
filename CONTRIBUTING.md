# Contributing

Thanks for taking a look. This is a small, focused tool — the bar for changes is "does it make session transfer more reliable or easier to understand".

## Setup

```bash
git clone https://github.com/<you>/dsh-sync.git
cd dsh-sync
npm install
npm start                 # run the GUI
node dsh-sync.mjs doctor  # run the CLI against your real ~/.dsh
```

Requires Node.js 22+.

## Project layout

| Path | What lives there |
|---|---|
| `gui/core.mjs` | All the real logic — scanning, zstd frame handling, path rewriting, backup/restore. **UI-agnostic; both the GUI and the CLI import it.** |
| `gui/main.cjs` | Electron main process. Owns the window, config file, and IPC handlers. Every filesystem write happens here. |
| `gui/preload.cjs` | Context-isolated bridge. The renderer can only call the whitelisted methods. |
| `gui/app.js` | Renderer logic. No Node access. |
| `dsh-sync.mjs` | Standalone CLI. Reimplements the menu but delegates all work to `core.mjs`. |
| `build/` | Packaging scripts. |

If you add a feature, put the logic in `core.mjs` and expose it through both entry points.

## The one invariant you must not break

DSH validates this on every read:

```
sessions/<projectKey(header.cwd)>/<encodeSegment(header.id)>/session.v4.jsonl.zstd
```

`assertStoredIdentity` recomputes the expected directory from the header and throws `corrupt session log` on mismatch. Any change to backup or restore must preserve this. The safest way to verify:

```bash
node dsh-sync.mjs doctor
```

and, if you have DSH's persistence layer available, open every restored session through `persistence.open(id, 'read')`.

## Testing a change

There is no test suite yet — this is the highest-value contribution. Until then, verify manually:

1. `node dsh-sync.mjs backup` against a real `~/.dsh`
2. Restore into a throwaway `DSH_HOME` **with a different workspace path** — this exercises the header rewrite
3. `node dsh-sync.mjs doctor` on the restored home
4. Launch DSH pointed at the restored home and open a few sessions, including a seeded/forked one and a subagent child

A useful harness would build synthetic session logs (zstd frames with a header + event frames) so this runs without a real DSH install. PRs welcome.

## Code style

- ESM (`.mjs`) for logic, CommonJS (`.cjs`) for Electron entry points
- No runtime dependencies beyond Electron for the GUI; zero for the CLI
- Comments explain *why*, not *what* — especially around zstd frame boundaries and DSH's directory invariants
- Chinese UI strings are fine; keep code identifiers and comments in English

## Reporting bugs

Include:

- OS and Node version
- Which backend (local / WebDAV / S3)
- The exact error text
- Output of `node dsh-sync.mjs doctor`

**Never paste `.credentials.yaml` or your `dsh-sync.config.json`** — they contain API keys and storage passwords.

## License

By contributing you agree your work is licensed under MIT.
