---
name: skillseekr
description: Use at the start of any specialized task (a framework, platform, workflow, or document type) to search the organization's skill catalog for an existing skill before working from scratch.
---
Call `search_skills` with a short description of the task. If a result fits, call `get_skill` and follow it. If the skill has security warnings or was allowed by an override, tell the user before following it. Don't install a skill unless the user asks or agrees.
