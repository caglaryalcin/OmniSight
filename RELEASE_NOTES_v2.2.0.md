# OmniSight v2.2.0

This release addresses all 12 open issues. Existing configurations remain backward compatible.

## Bug Fixes

- **#4 — The Windows agent is now independent of the operating system language.** Localized `Get-Counter` paths were replaced with language-neutral CIM performance classes for disk and network metrics. TLS 1.2 is also explicitly enabled for older Windows and PowerShell installations.
- **#6 — PBS no longer reports false “partial data” warnings.** Datastore access is treated as required, while version, node and recent-task endpoints are optional. Optional permission failures are shown as warnings; actual datastore access failures now include a clear ACL hint.
- **#9 — QNAP username/password authentication was fixed.** Passwords are sent as UTF-8 Base64 with the QTS `serviceKey` parameter. Model, firmware and hostname details are extracted from the login response, while existing SID authentication remains supported.
- **#12 — Proxmox API configuration and agent inventory were separated.** Multiple independent Proxmox servers or clusters can now be saved through `instances[]`. “Add Node” was renamed to the clearer “Install Agent”, and live agent inventory is shown separately from persistent API configuration. Legacy single-URL configuration remains supported.
- **#18 — Dashboard time ranges now load and render the requested history.** Selecting a wider range fetches history from a dedicated endpoint, compact refreshes preserve older points, charts use real timestamps instead of fixed 15-second indexes, gaps are not connected, and long series are decimated for browser performance. Invalid `OMNISIGHT_VIEW_HISTORY_POINTS` values can no longer disable the history cap.
- **#20 — Dockhand environment handling and Docker metric merging were fixed.** Containers from every environment retain the correct environment identity. Matching direct Docker integrations enrich Dockhand rows with CPU, memory, network, disk I/O and image-update data. Docker CPU and memory summaries are normalized as 0–100 host percentages, and Linux page cache is excluded from memory usage.
- **#22 — Dashboard card titles remain readable at narrow widths.** Titles can wrap to two lines, and badges and controls move into a responsive grid layout when a card becomes narrow.
- **#23 — Synology CPU usage now uses the correct SNMP source priority.** OmniSight first uses UCD-SNMP raw CPU deltas and `ssCpuIdle`, then HOST-RESOURCES, and only uses the potentially stale Synology vendor CPU OIDs as a final fallback. The result is clamped to 0–100.

## New Features

- **#5 — Pending operating-system updates.** Windows Update and local Linux package-manager metadata now report pending update counts and reboot-required state. Checks are cached for 30 minutes so the normal 15-second agent report interval does not repeatedly query the package manager. The Windows and Linux agent version is now `1.3.0`.

## Previously Completed and Verified

- **#7 — UniFi integration.** UniFi gateway/controller API support, settings and dashboard views are present and protected by smoke tests.
- **#10 — Public Status naming.** Synology is displayed as “Synology” instead of the old generic “SNMP” label, with a regression check included.
- **#24 — ARM64 Docker image.** The release workflow publishes multi-architecture `linux/amd64` and `linux/arm64` images, and the ARM64 build configuration is covered by regression checks.

## Security and Quality

- Added local mock API coverage for QNAP authentication and PBS permission behavior.
- Added CI regression coverage for Docker resource normalization, Dockhand/Docker merging, multiple Proxmox API instances and every issue included in this release.
- Production dependency auditing remains clean at the high-severity threshold.
