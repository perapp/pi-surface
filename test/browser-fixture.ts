import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SurfaceServer } from '../src/server.ts';

export async function browserFixture(host = '127.0.0.1', port = 0) {
  const root = await mkdtemp(join(tmpdir(), 'pi-surface-browser-'));
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const model = { id: 'demo', provider: 'test', name: 'Demo · no inference' };
  const state = {
    session: { id: 'browser-test', name: 'Surface integration lab', cwd: root, leafId: 'u1', model, thinkingLevel: 'medium', idle: true, pending: false, contextUsage: { percent: 3 } },
    uiPrompt: null as null | { type: string; kind: string; title: string },
    messages: [{ id: 'u1', role: 'user', content: 'This is a demo session; controls are mocked. No inference is performed.', timestamp: 1 }],
    models: [model, { ...model, id: 'second', name: 'Second demo model' }],
    commands: [
      { name: 'demo', description: 'A test command', source: 'extension' },
      { name: 'skill:review', description: 'Review code with a skill', source: 'skill' },
      { name: 'summarize', description: 'Summarize with a prompt template', source: 'prompt' },
    ], tools: [{ name: 'read', description: 'Read files', active: true }],
    tree: [{ id: 'u1', parentId: null, type: 'message', role: 'user', text: 'user: Demo request' }], capabilities: { sessionControl: true },
  };
  let failNext = false;
  const server = new SurfaceServer({ cwd: root, trusted: true, globalRoot: join(root, 'global'), host, port,
    state: () => state,
    invoke: (method, params) => {
      if (failNext) { failNext = false; throw new Error('Simulated failure'); }
      calls.push({ method, params });
      if (['prompt', 'steer', 'followUp'].includes(method)) {
        const message = { id: 'm' + calls.length, role: 'user', content: String(params.text), timestamp: Date.now() };
        state.messages.push(message); server.publish({ type: 'message_end', message });
      }
      if (method === 'renameSession') state.session.name = String(params.name);
      if (method === 'setThinkingLevel') state.session.thinkingLevel = String(params.level);
      if (method === 'abort') state.session.idle = true;
      if (method === 'listSessions') return [{ id: 'saved', path: '/demo/saved.jsonl', name: 'Saved demo' }];
      server.publish({ type: 'state_changed' }); return { accepted: true };
    },
  });
  try {
    await server.start();
    await writeFile(join(root, 'results.json'), '{"passed":3}');
    const surface = await server.store.create({ id: 'test', name: 'Reactive report', default: true, watch: ['results.json'], html: `<!doctype html><html><head><meta charset="utf-8"><title>Reactive report</title></head><body style="font:16px system-ui;padding:36px;background:#f0f5f9;color:#243e54"><h1>Reactive report</h1><p id="value">Loading</p><button id="ask">Investigate failures</button><p id="result"></p><script>
async function refresh(){const value=await surface.read('results.json');document.querySelector('#value').textContent=value.passed+' passed';}
surface.watch(refresh);refresh();surface.on('test-update',data=>document.querySelector('#result').textContent=data.text);
document.querySelector('#ask').onclick=()=>pi.followUp('Investigate this report');
</script></body></html>` });
    return { root, server, state, surface, calls, failNext: () => { failNext = true; }, close: async () => { await server.close(); await rm(root, { recursive: true, force: true }); } };
  } catch (error) { await server.close(); await rm(root, { recursive: true, force: true }); throw error; }
}
