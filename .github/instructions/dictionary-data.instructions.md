---
description: "Project-specific mutual translation data contract"
applyTo: "app.js"
---

Use the explicit `sourceLang + aliases + translation + explanationZh` schema for mutual translation demo entries.

- `sourceLang` must be either `zh` or `en`.
- `aliases` are only for lookup and must not determine output direction.
- `translation` is always the target-language output.
- `explanationZh` is always written in Chinese.
- Do not reintroduce nested `zh/en` translation objects for direction inference.
- Demo data, tests, and future real dictionary data must follow the same schema.
