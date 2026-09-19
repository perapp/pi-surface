import assert from 'node:assert/strict';
import type { Browser, Page } from 'playwright';

type TestViewport = EventTarget & { height: number; width: number; offsetTop: number; offsetLeft: number; scale: number };

async function setVisibleViewport(page: Page, height: number, offsetTop = 0, scale = 1) {
  await page.evaluate(({ height, offsetTop, scale }) => {
    const viewport = window.visualViewport as unknown as TestViewport;
    Object.assign(viewport, { height, offsetTop, scale });
    viewport.dispatchEvent(new Event('resize'));
    viewport.dispatchEvent(new Event('scroll'));
  }, { height, offsetTop, scale });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function assertComposerVisible(page: Page, top: number, bottom: number) {
  const geometry = await page.evaluate(() => {
    const [shell, prompt, send, attach, actions] = ['.shell', '#prompt', '#send', '#attach', '#actions-open'].map(selector => {
      const rect = document.querySelector(selector)!.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, height: rect.height };
    });
    return { shell, prompt, send, attach, actions,
      scrollHeight: document.documentElement.scrollHeight, height: innerHeight, scrollY,
      scrollWidth: document.documentElement.scrollWidth, width: innerWidth };
  });
  assert.ok(Math.abs(geometry.shell.top - top) <= 1, JSON.stringify(geometry));
  assert.ok(Math.abs(geometry.shell.bottom - bottom) <= 1, JSON.stringify(geometry));
  assert.ok(geometry.actions.right <= geometry.send.left, 'Actions must be immediately left of Send');
  assert.ok(Math.abs(geometry.actions.top - geometry.send.top) <= 1, 'Actions and Send must share a row');
  for (const key of ['prompt', 'send', 'attach', 'actions'] as const) {
    assert.ok(geometry[key].top >= top && geometry[key].bottom <= bottom + 1, `${key} outside visible viewport: ${JSON.stringify(geometry)}`);
    assert.ok(geometry[key].left >= 0 && geometry[key].right <= geometry.width + 1, `${key} overflows horizontally`);
  }
  assert.equal(geometry.scrollY, 0, 'outer document must not scroll');
  assert.ok(geometry.scrollHeight <= geometry.height + 1, 'outer document must not grow with its content');
  assert.ok(geometry.scrollWidth <= geometry.width + 1);
}

/** Simulate mobile browser chrome/keyboard shrinking only the visual viewport,
 * not the layout viewport or CSS dvh. Desktop viewport resizing alone misses this. */
export async function checkMobileLayout(browser: Browser, url: string) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  await context.addInitScript(() => {
    if (window !== window.top) return;
    const viewport = Object.assign(new EventTarget(), { height: 660, width: 390, offsetTop: 0, offsetLeft: 0, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true });
  });
  try {
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector('#connection')?.textContent === 'Live');
    assert.equal(await page.locator('#prompt-panel').isHidden(), true);
    await page.locator('#prompt-quick-toggle').click();
    assert.equal(await page.locator('#sidebar').isHidden(), true);
    await assertComposerVisible(page, 0, 660);
    await page.locator('#prompt').fill('Keep the composer above the keyboard');
    await setVisibleViewport(page, 360);
    await assertComposerVisible(page, 0, 360);
    // Some engines pan the visual viewport while focusing an input.
    await setVisibleViewport(page, 360, 44);
    await assertComposerVisible(page, 44, 404);
    // Zoom must remain available: don't reflow the app into the magnified viewport.
    await setVisibleViewport(page, 180, 100, 2);
    const height = await page.locator('.shell').evaluate(el => el.getBoundingClientRect().height);
    assert.equal(height, 360);
    await setVisibleViewport(page, 660);
    await assertComposerVisible(page, 0, 660);
    assert.equal(await page.locator('#prompt').inputValue(), 'Keep the composer above the keyboard');
    // Long content must scroll inside the iframe, not push down the composer.
    await page.frameLocator('#surface-frame').locator('body').evaluate(body => { body.innerHTML = '<div style="height:5000px">hello world</div>'; });
    await page.evaluate(() => window.scrollTo(0, 3000));
    await assertComposerVisible(page, 0, 660);
    await page.screenshot({ path: 'artifacts/mobile-layout.png' });
    await setVisibleViewport(page, 360);
    await page.screenshot({ path: 'artifacts/mobile-keyboard.png' });
  } finally { await context.close(); }
}
