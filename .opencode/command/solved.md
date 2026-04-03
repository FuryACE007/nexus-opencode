---
description: Confirm the last /solve issue is fixed and capture resolution in knowledge base
---

Use the nexus-solved tool to confirm the last issue is resolved.

{% if arguments %}
The developer provided this note about the fix: {{ arguments }}
Pass it as the `note` argument.
{% else %}
No explicit note was provided. The tool will use the last git commit diff automatically.
{% endif %}
