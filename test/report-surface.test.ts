import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');

async function text(path: string): Promise<string> {
  return readFile(resolve(root, path), 'utf8');
}

test('package ships the Adaptive Report Surface skill and prompt', async () => {
  const manifest = JSON.parse(await text('package.json')) as {
    files: string[];
    pi: { skills: string[]; prompts: string[] };
  };

  assert.ok(manifest.files.includes('skills'));
  assert.ok(manifest.files.includes('prompts'));
  assert.ok(manifest.pi.skills.includes('./skills'));
  assert.ok(manifest.pi.prompts.includes('./prompts'));

  const [skill, protocol, prompt] = await Promise.all([
    text('skills/report-surface/SKILL.md'),
    text('skills/report-surface/references/protocol.md'),
    text('prompts/report-surface.md'),
  ]);

  for (const action of ['adaptive-report-regenerate', 'adaptive-report-expand']) {
    assert.match(skill, new RegExp(action));
    assert.match(protocol, new RegExp(action));
  }
  for (const event of ['adaptive-report-replaced', 'adaptive-report-expanded']) {
    assert.match(protocol, new RegExp(event));
  }
  assert.match(skill, /target reading time/i);
  assert.match(prompt, /2, 5, 10, or 15 minutes/);
});
