[Original README](https://github.com/router-for-me/CLIProxyAPI/blob/main/README.md)

## Fork changes

- Model usage in Observe > Model usage: execution rankings, timelines with animated filter transitions, provider/model filters, requested/routed/reported models, token breakdowns, failures, request details and JSON export. Click a model to filter its traffic without collapsing the model list. Other models dim and remain clickable. Token counts use compact K/M units, with exact values on hover. History survives restarts. Uses the console's navigation, session, theme and provider icons.
- Quota outlook in Observe > Quota Management for Claude, Codex and Kimi: one card per provider with the pooled remaining quota (subscriptions scaled by size, e.g. Pro = 2.5x), recorded and projected lines with refill markers, pool-empty, first-empty, next-reset and recent burn figures, burn-rate (1h/3h/6h) and future-usage choices, an account filter, two-week range navigation, drain-rate charts and per-provider token usage. Follows the console's session, provider tab and theme.
- Quota history: hourly checks and console refreshes, retained for 14 days.
- Forecasts account for subscription sizes, usage pace, resets and redistribution when subscriptions run out. Use weekly limits, or monthly limits when weekly limits are unavailable.
- Quota windows show used/remaining bars, monthly Kimi limits and credential notes as subscription names.
- Kimi sign-ins renew before tokens become unusable.
- Windows deployment builds, backs up and replaces the executable, checks health and rolls back on failure. Preserves production configuration and credentials.
