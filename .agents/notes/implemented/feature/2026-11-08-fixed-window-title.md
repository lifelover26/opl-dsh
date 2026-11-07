---
kind: feature
status: implemented
date: 2026-11-08
---

# Fixed desktop window title

The OPL Client can keep the renderer document title as `DeepSeek Harness` so the Windows taskbar and application title do not follow the active Session title. The preference is enabled by default in General settings and can be disabled to restore the title observed before the fixed-title mode was enabled. A renderer observer repairs title changes made by the official Session navigation while the preference is active.
