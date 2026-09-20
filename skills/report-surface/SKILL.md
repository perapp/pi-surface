---
name: report-surface
description: Creates Adaptive Report Surfaces—polished, long-form interactive explainers whose reading level and target reading time can be regenerated through Pi, with per-section “Tell me more” expansion. Use when the user asks for a report surface, adaptive report, interactive explainer, or a report that can be simplified, made technical, shortened, lengthened, or explored section by section.
---

# Adaptive Report Surface

An **Adaptive Report Surface** is a subject-specific reading experience, not a generic dashboard. It begins as a coherent report and lets the reader request a new inference for a different reading level or target reading time. Each section can independently grow through a **Tell me more** action.

Read [`../pi-surface/SKILL.md`](../pi-surface/SKILL.md) for the core Surface lifecycle and browser API, then read [`references/protocol.md`](references/protocol.md) before building or responding to an Adaptive Report Surface.

## Create

1. Establish the topic, likely audience, and source of truth. Research when accuracy or freshness requires it.
2. Choose an initial reading level and target time from the request. Default to **general** and **5 minutes**.
3. Build real report content—never placeholder copy. At roughly 200 words per minute, use these ranges:
   - 2 minutes: 300–450 words, usually 3–4 sections
   - 5 minutes: 800–1,100 words, usually 4–6 sections
   - 10 minutes: 1,600–2,200 words, usually 6–8 sections
   - 15 minutes: 2,500–3,200 words, usually 7–10 sections
4. Design around the subject’s own visual language. Use local assets and system fonts only. Avoid reusing one generic report aesthetic across unrelated topics.
5. Put the adaptation controls in the opening section:
   - a **Technical depth** dropdown with **Plain language**, **General audience**, **Technical**, and **Expert** options—never label readers as smart or dumb;
   - a **Reading time** dropdown with **2 min**, **5 min**, **10 min**, and **15 min** options;
   - one explicit **Regenerate report** button so the reader can change both settings with a single inference;
   - the active settings and a live status region explaining when Pi is regenerating the report.
6. Give every substantive section a stable ID and a **Tell me more** button. Repeated expansion may say **Go deeper still**.
7. Keep the report data-driven so a regenerated report may change section count as well as wording. Whole-report replacement should not depend on fixed DOM nodes from the initial version.
8. Create and open the surface with the `surface` tool. Keep it temporary unless the user asks for durable project/global storage.

## Interaction rules

- Changing either dropdown is local UI state. Only the explicit **Regenerate report** button sends an `adaptive-report-regenerate` action to Pi, combining both selected values in one inference. Do not approximate the result through client-side truncation, hidden prewritten variants, or CSS.
- A section expansion sends `adaptive-report-expand`. Generate useful additional detail rather than restating the visible section.
- Include the current report state in each action. Surface events are transient, and the model must have enough context to respond after compaction.
- Use the bridge-provided `surface.id` as the canonical, scope-qualified surface ID. Never hard-code or derive the return address from the creation slug.
- Include a unique `requestId` from `surface.requestId()`; ignore stale responses in the browser. Do not use `crypto.randomUUID()`, because it is unavailable on non-secure HTTP origins.
- The action promise acknowledges queueing only. Keep a loading state until the matching emitted event arrives, with a timeout that restores controls and explains how to retry.
- Never invoke inference on page load, rendering, reconnect, or a watched-file callback.
- Use local disclosure for content that already exists. Invoke Pi only when the reader requests new reasoning or prose.
- Insert generated text with `textContent` and explicit DOM construction, not `innerHTML`.
- Preserve keyboard focus, visible focus styles, responsive controls, live status announcements, and reduced-motion preferences.

## Handle actions

When the session receives a structured `Surface action:` message using this protocol:

1. Perform the requested rewrite or expansion.
2. Read the canonical, scope-qualified `surfaceId` from the top level of the `Surface action:` envelope. Call the `surface` tool with `action: "emit"`, using that exact ID and the response event specified in `data.responseEvent`. Do not use `data.surfaceId` as the return address.
3. Echo the same `data.requestId` in the event payload so the page can reject stale results.
4. For regeneration, return a complete replacement report at the requested level and length. Adjust section count when useful.
5. For expansion, return only the requested section addition and avoid repeating its current content.
6. After the emit succeeds, respond with at most one short confirmation sentence.

Do not answer only in chat: the surface event is the application result.
