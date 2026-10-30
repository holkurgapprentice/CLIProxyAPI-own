package usageinsights

import "embed"

//go:embed index.html app.js bridge.js icons.js
var Assets embed.FS
