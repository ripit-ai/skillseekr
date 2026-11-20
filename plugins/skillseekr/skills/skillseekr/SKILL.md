---
name: skillseekr
description: Use at the start of any specialized task (a framework, platform, workflow, or document type) to search the organization's skill catalog for an existing skill before working from scratch.
---
Call `search_skills` with a short description of the task. If a result fits, call `get_skill` and follow it. Don't install a skill unless the user asks or agrees. If the catalog is empty or the user asks for newer skills, offer to call update_skills; only call it if they agree.
