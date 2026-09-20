---
name: pi-surface
description: Creates interactive, reactive web applications connected to the current Pi session. Use when the user asks for a surface, dashboard, interactive report, visualization, form, or second-brain UI, or wants to modify an existing Pi Surface application.
---

# Pi Surface

The `surface` tool belongs to this running Pi process. It does not create a second agent. Never implement your own model API call, separate Pi process, authentication endpoint, or web server just to render a surface.

## Create

1. Identify the source of truth. For mutable files, declare `watch` dependencies **relative to cwd** (not the surface directory). Globs and directories must stay inside cwd. Declare only files the browser needs; dependency declarations also grant read access. Never expose secrets through broad globs.
2. Call `surface` with `action: "create"`, a slug `id`, a human `name`, `html`, and optional `watch`. This creates a private temporary surface and selects it in connected browsers. Use `action: "list"` to find existing surfaces first.
3. The result includes the surface ID and directory. Use normal file tools to edit/add HTML/CSS/JS in that directory. Assets hot reload automatically. Do not overwrite the user's current surface without considering its existing code/data.
4. Use `action: "open", id` to select a surface. Authentication URLs and QR codes are shown by `/surface` in the TUI, not returned to the model. Don't read credentials out of the server/process.
5. If the user wants durable storage, `action: "promote", id, scope: "project"` copies it to `.pi/agent/surfaces/`; `scope: "global"` saves under the agent config directory. It won't overwrite an existing directory. Project/global writes require the user's ordinary write authorization.

Project files use a `surface.json` manifest:

```json
{
  "name": "Test report",
  "entry": "index.html",
  "default": true,
  "watch": ["results.json", "reports/*.json"]
}
```

## Browser runtime

`window.pi`, `window.surface`, and `surface.pi` are injected before your scripts. Do not bundle or hardcode credentials. Use local assets; external CDNs, fonts, scripts, and API fetches are blocked by the default CSP.

```html
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Results</title></head>
<body>
  <h1>Test results</h1>
  <pre id="results"></pre>
  <button id="analyze">Investigate failures</button>
  <p id="error" role="alert"></p>
  <script>
    async function refresh() {
      try {
        const data = await surface.read('results.json');
        document.querySelector('#results').textContent = JSON.stringify(data, null, 2);
      } catch (error) {
        document.querySelector('#error').textContent = error.message;
      }
    }
    surface.watch(refresh);
    refresh();
    document.querySelector('#analyze').onclick = async () => {
      try { await pi.followUp('Investigate failures in results.json'); }
      catch (error) { document.querySelector('#error').textContent = error.message; }
    };
  </script>
</body>
</html>
```

- `surface.id` is the canonical runtime-qualified ID (`temporary:slug`, `project:slug`, or `global:slug`). Use this exact value as the return address for actions and emitted events; do not hard-code the creation slug.
- `surface.requestId()` returns a UUID-shaped correlation ID on both secure HTTPS and plain HTTP origins. Use it instead of `crypto.randomUUID()`, which is unavailable in browsers on non-secure HTTP origins.
- `surface.read(path)` reads a declared dependency, returning JSON for JSON files and text otherwise.
- `surface.watch(callback)` observes all declared dependencies; `surface.watch(path, callback)` filters an exact path. Without callbacks, dependency changes reload the page. No inference is needed to refresh data.
- `pi.prompt(text, {attachments})` submits when idle; `pi.steer(...)` steers a running agent; `pi.followUp(...)` queues until the agent finishes. Always show failures and avoid accidental repeated inference from render/watch callbacks.
- These promises acknowledge submission, **not the final model answer**. Use `pi.on('message_update', callback)` to observe the session stream.
- `surface.action(action, target, data)` sends a structured request to this same session; useful for `simplify`, `expand`, `condense` and `investigate` buttons. The resulting `Surface action:` message includes a top-level canonical `surfaceId`; use that ID—not a nested application-data ID—when emitting a response.
- `surface.attach(fileInput.files)` uploads and returns attachment objects, accepted by the `attachments` option. Never supply local server paths from JavaScript. File picker, drop, and image paste already exist in the surrounding shell, so don't duplicate them unless the application needs a specific drop target.
- `surface.on('section-updated', callback)` listens for an app-specific event. Send one from Pi with `surface` tool `{action:'emit',id,event:'section-updated',data:{...}}`. Use DOM `textContent` for untrusted text rather than `innerHTML`.
- `pi.abort()`, `pi.getSession()`, and `pi.invoke(method, params)` expose the documented harness controls. Read [the project README](../../README.md) for the method list and limitations.

## Design and lifetimes

Keep sorting/filtering/collapsing client-side. Only requests requiring reasoning should invoke Pi. Use responsive, accessible HTML and clear loading/error states. Preserve the persistent shell composer; generated UI is only the central workspace.

Surfaces are **trusted harness applications**, not isolated hostile documents. Do not insert third-party executable content or assume an iframe is a security boundary.

Pi 0.85 recreates extensions during `/reload` and session replacement. Pi Surface hands credentials and its listening address to the fresh extension instance, so connected browsers normally reconnect automatically. `/reload` also preserves temporary surfaces and uploaded files. New, resumed, and forked sessions keep the browser draft but start with fresh temporary surfaces and uploads; project/global surfaces survive those boundaries. Temporary files are deleted on `/surface stop` or quit. Ingest/copy uploads before changing sessions or exiting Pi. Do not promise temporary files will exist when resuming an old transcript.
