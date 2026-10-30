[Original README](https://github.com/router-for-me/CLIProxyAPI/blob/main/README.md)

## Fork changes

- Model usage insights under Observe > Model usage, opening inside the console with its active navigation, session and live theme: execution-count ranking and timeline by default, requested, routed and response-reported models by provider, reported token categories, hourly history, failures, request details and JSON export. Keeps up to 100,000 attempts in memory and two 32 MiB journal segments beside the config. Respects `usage-statistics-enabled`; stores no prompts or API keys. No skill tracking or subscription cost estimates.
- Quota outlook in Observe → Quota Management: pooled remaining quota with forecast and drain-rate charts, following the console session, provider tab and theme.
- Quota history (Claude, Codex, Kimi): hourly quota checks plus console refreshes, kept 14 days (`/v8/management/quota/history`).
- Forecast: weekly limits (monthly when a subscription has none), average daily pace, refills at each reset, and work from an exhausted subscription moved to the provider's others by measured size.
- Console add-ons: per-subscription chart breakdown, "used / left" Quota windows bars, credential notes shown as names, and monthly Quota windows bars for subscriptions without a weekly limit (Kimi).
- Kimi sign-ins renew on time: expiry comes from the stored `expired` time, because Kimi tokens claim to last an hour longer than Kimi accepts them.
- Windows promotion script: build, back up, replace only the executable, health-check, roll back on failure.
- Local agent rules in AGENTS.md.

Promote with `./scripts/Promote-Production.ps1` (`-WhatIf` to preview, `-RunTests` for the full suite). Set the production directory in `.env.promotion` (copy `.env.promotion.example`); config and credentials there stay in place.

To try model usage insights in isolation, build with `./scripts/Build-Windows.ps1`, then run `python scripts/usage_insights_demo.py`. Open `http://127.0.0.1:18319/usage-insights/` with the dummy management key `prototype-local-only`. This uses synthetic streaming and non-streaming requests against local mock providers through the real proxy executors. It creates its own config and journal under `artifacts/usage-insights-demo`, uses no production credentials, and stops with Ctrl+C. Pass `--seed 0` to inspect retained history without generating another batch. Pass `--console-asset <path-to-management.html>` to test the navigation entry against an existing downloaded console copy.
