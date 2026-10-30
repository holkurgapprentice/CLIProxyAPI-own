[Original README](https://github.com/router-for-me/CLIProxyAPI/blob/main/README.md)

## Fork changes

- Model usage in Observe > Model usage: execution rankings, timelines, provider/model filters, requested/routed/reported models, token breakdowns, failures, request details and JSON export. History survives restarts. Uses the console's navigation, session, theme and provider icons.
- Quota outlook in Observe > Quota Management for Claude, Codex and Kimi: pooled remaining quota, per-subscription breakdowns, forecasts and drain-rate charts. Follows the console's session, provider tab and theme.
- Quota history: hourly checks and console refreshes, retained for 14 days.
- Forecasts account for subscription sizes, usage pace, resets and redistribution when subscriptions run out. Use weekly limits, or monthly limits when weekly limits are unavailable.
- Quota windows show used/remaining bars, monthly Kimi limits and credential notes as subscription names.
- Kimi sign-ins renew before tokens become unusable.
- Windows deployment builds, backs up and replaces the executable, checks health and rolls back on failure. Preserves production configuration and credentials.
