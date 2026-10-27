package quotaoutlook

import "embed"

// Assets are fork-owned and independent of downloaded management releases.
//
//go:embed index.html app.js math.js management.js
var Assets embed.FS
