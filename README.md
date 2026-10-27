[Original README](https://github.com/router-for-me/CLIProxyAPI/blob/main/README.md)

## Fork changes

- Quota outlook in Observe → Quota Management: pooled remaining quota with forecast and drain-rate charts, following the console session, provider tab and theme.
- Quota history: hourly quota checks plus console refreshes, kept 14 days (`/v8/management/quota/history`).
- Forecast: average daily pace, refills at each reset, and work from an exhausted subscription moved to the provider's others by measured size.
- Console add-ons: per-subscription chart breakdown, "used / left" Quota windows bars, and credential notes shown as names.
- Windows promotion script: build, back up, replace only the executable, health-check, roll back on failure.
- Local agent rules in AGENTS.md.

Promote with `./scripts/Promote-Production.ps1` (`-WhatIf` to preview, `-RunTests` for the full suite). Set the production directory in `.env.promotion` (copy `.env.promotion.example`); config and credentials there stay in place.
