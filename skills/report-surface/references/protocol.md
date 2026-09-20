# Adaptive Report Surface protocol

Use this contract unless the report has a documented reason to extend it. The server remains generic: browser actions become user messages, and the model returns application data with `surface emit`.

## Report state

Keep a serializable state object in the page:

```js
const report = {
  protocol: 'adaptive-report/v1',
  surfaceId: surface.id, // canonical runtime ID, e.g. temporary:topic-report
  topic: 'The Linux kernel',
  title: 'Inside the Linux kernel',
  lede: '...',
  readingLevel: 'general',   // plain | general | technical | expert
  targetMinutes: 5,
  sections: [
    {
      id: 'processes',       // stable within this report version
      eyebrow: 'Scheduling',
      title: 'How work gets time on a CPU',
      paragraphs: ['...', '...'],
      callout: { label: 'Key idea', text: '...' },
      expansions: []
    }
  ],
  closing: { title: '...', paragraphs: ['...'] },
  sources: []
};
```

The visual design may add fields, but action payloads must remain self-contained. Do not put secrets, credentials, or local filesystem paths in state. `surface.id` is assigned by the bridge and includes the runtime scope (`temporary:`, `project:`, or `global:`). Always use it instead of hard-coding the creation slug. If a regenerated report contains a different `surfaceId`, replace it with `surface.id` before storing the report.

## Whole-report regeneration

Send only after an explicit reader action:

```js
const requestId = surface.requestId();
await surface.action('adaptive-report-regenerate', 'report', {
  protocol: 'adaptive-report/v1',
  surfaceId: surface.id,
  requestId,
  requested: {
    readingLevel: 'technical',
    targetMinutes: 10
  },
  currentReport: report,
  responseEvent: 'adaptive-report-replaced',
  instruction: 'Return a complete replacement report. Match the requested reading level and approximate reading time; preserve factual accuracy and the report’s subject-specific voice.'
});
```

The model emits:

```json
{
  "action": "emit",
  "id": "temporary:topic-report",
  "event": "adaptive-report-replaced",
  "data": {
    "requestId": "same-id",
    "report": {
      "protocol": "adaptive-report/v1",
      "surfaceId": "temporary:topic-report",
      "topic": "The Linux kernel",
      "title": "Inside the Linux kernel",
      "lede": "...",
      "readingLevel": "technical",
      "targetMinutes": 10,
      "sections": [],
      "closing": { "title": "...", "paragraphs": [] },
      "sources": []
    }
  }
}
```

The handler must use the top-level `surfaceId` from the `Surface action:` envelope as the emit tool's `id`; that value is the authoritative return address. The browser must compare `requestId` with its pending request before replacing state and normalize the replacement with `report = { ...data.report, surfaceId: surface.id }`. A full replacement normally clears previous expansions because their level may no longer match.

## Section expansion

Send the current section and report settings, not merely its ID:

```js
const requestId = surface.requestId();
await surface.action('adaptive-report-expand', section.id, {
  protocol: 'adaptive-report/v1',
  surfaceId: surface.id,
  requestId,
  topic: report.topic,
  readingLevel: report.readingLevel,
  targetMinutes: report.targetMinutes,
  currentSection: section,
  responseEvent: 'adaptive-report-expanded',
  instruction: 'Add genuinely useful detail without repeating the visible section. Nested subsections are allowed.'
});
```

The model emits:

```json
{
  "action": "emit",
  "id": "temporary:topic-report",
  "event": "adaptive-report-expanded",
  "data": {
    "requestId": "same-id",
    "sectionId": "processes",
    "expansion": {
      "id": "processes-detail-1",
      "heading": "A closer look at preemption",
      "paragraphs": ["...", "..."],
      "nestedSections": [
        { "heading": "Real-time classes", "paragraphs": ["..."] }
      ]
    }
  }
}
```

Append the expansion to that section only. Permit later expansion requests and change the label to **Go deeper still** after the first success.

## Browser-side response outline

```js
let pending = null;
let timeoutId = null;

function beginRequest(kind, target) {
  const requestId = surface.requestId();
  pending = { requestId, kind, target };
  setBusy(true);
  clearTimeout(timeoutId);
  timeoutId = setTimeout(() => {
    if (pending?.requestId !== requestId) return;
    pending = null;
    setBusy(false);
    setStatus('Generation did not finish. Try again.');
  }, 120_000);
  return requestId;
}

function accept(data, kind) {
  if (!pending || pending.kind !== kind || data.requestId !== pending.requestId) return false;
  clearTimeout(timeoutId);
  pending = null;
  setBusy(false);
  return true;
}

surface.on('adaptive-report-replaced', data => {
  if (!accept(data, 'regenerate')) return;
  report = { ...data.report, surfaceId: surface.id };
  renderReport(); // construct nodes and assign generated strings with textContent
});

surface.on('adaptive-report-expanded', data => {
  if (!accept(data, 'expand')) return;
  const section = report.sections.find(item => item.id === data.sectionId);
  if (!section) return;
  (section.expansions ??= []).push(data.expansion);
  renderSection(section.id);
});
```

A report can support one pending inference at a time for a simpler interface. If it supports concurrent section requests, keep a `Map` keyed by `requestId` instead.

## Technical-depth behavior

Use a dropdown labelled **Technical depth**, not “smartness” or intelligence. Its values map to:

- **plain** — display **Plain language**: everyday vocabulary, short sentences, concrete analogies, and definitions for unavoidable terms.
- **general** — display **General audience**: informed non-specialist, accurate terminology with compact explanations.
- **technical** — display **Technical**: domain vocabulary, mechanisms, constraints, and quantitative detail where useful.
- **expert** — display **Expert**: assumes foundational knowledge; focuses on nuance, unresolved questions, and implementation or theory details.

Changing this dropdown or the reading-time dropdown must not immediately invoke Pi. An explicit **Regenerate report** button submits both selected values together, avoiding duplicate inference when the reader wants to change both.

## Reading-time behavior

Use a **Reading time** dropdown with 2, 5, 10, and 15-minute options. Estimate body prose at about 200 words per minute. A changed target may alter section count and structure; do not merely pad or truncate paragraphs. Prioritize a coherent arc:

1. orient the reader;
2. explain the essential mechanism or thesis;
3. add examples, evidence, or consequences as time allows;
4. finish with the most useful synthesis or open question.

Display the target as an estimate, not a promise. Source lists, captions, and generated expansions do not count toward the base reading time.

## Failure and accessibility

- Surface action promises confirm submission, not generation completion.
- Show a specific loading label such as “Rewriting for a 10-minute technical read…” in an `aria-live="polite"` region.
- Disable controls that would launch conflicting requests, but do not lock ordinary navigation or local disclosure.
- Restore controls on submission failure or timeout.
- Keep rendered headings hierarchical and every control keyboard-operable.
- Respect `prefers-reduced-motion`; scrolling should remain usable without animation.
