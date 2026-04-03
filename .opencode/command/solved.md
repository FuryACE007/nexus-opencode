---
description: Confirm the last /solve issue is fixed and capture resolution in knowledge base
---

Use the nexus-solved tool to confirm the last issue is resolved.

If the developer provided a note, pass it as the `note` argument: $ARGUMENTS

If $ARGUMENTS is empty, call nexus-solved with no note — the tool will use the last git commit diff automatically.
