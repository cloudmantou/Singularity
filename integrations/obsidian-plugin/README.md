# Singularity Obsidian Plugin

This is a first-pass Obsidian connector for the Singularity memory engine.

It intentionally uses the Obsidian Vault API and HTTPS REST calls only. It does
not require direct server access to a local Vault directory and does not scan the
whole Vault in the background.

## Commands

- `Singularity: Save current note`
- `Singularity: Save selection`
- `Singularity: Open search`
- `Singularity: Export managed memories`

## Settings

- `Singularity endpoint`: for example `https://agent.mtzs.cloud`
- `Auth token`: bearer token for the Singularity API
- `Vault ID`: stable ID used by the backend external link table
- `Managed folder`: local folder where pulled Markdown files are written

## Build

```bash
npm install
npm run build
```

Copy `manifest.json`, `main.js`, and `styles.css` if present into:

```text
<vault>/.obsidian/plugins/singularity-obsidian/
```
