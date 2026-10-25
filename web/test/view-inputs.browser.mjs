// Input attributes, real browser (rc-v25 finding N2). Preact sets a prop as a DOM property when
// the element has a property of that name. spellcheck, autocorrect, translate and draggable are
// boolean properties, so the strings "false", "off" and "no" turned each feature on. This checks
// every name field the dialogs draw, then renders a probe through the view layer's html tag with
// every attribute the audit covers and reads back both the attribute and the browser's property.
// It runs in two browsers: Chrome 149 has no autocorrect property, so Preact sets that one as an
// attribute, and Chromium 153 has the property, where "off" read as on.
//
//   node test/view-inputs.browser.mjs
import assert from 'node:assert/strict';
import { chromium } from '/usr/lib/node_modules/playwright-chromium/index.mjs';
import { ScriptedAgent, startHub, hubSession, launchBrowser, login, report } from './view-harness.mjs';

const PORT = 18416;
const SECRET = 'view-inputs-secret';
const PASSWORD = 'view-inputs-password';
const NAMES = ['alpha', 'beta'];

const hub = await startHub({ port: PORT, secret: SECRET, password: PASSWORD });
const agent = new ScriptedAgent(SECRET, NAMES);
const passed = [];
const pass = report(passed);

// What the page and the browser make of every text input in the open dialog.
const READ_INPUTS = () => [...document.querySelectorAll('#modal-root input.inp[type="text"]')].map((el) => ({
  label: el.closest('label')?.querySelector('.field-label')?.textContent || '',
  autocorrect: el.getAttribute('autocorrect'),
  spellcheck: el.getAttribute('spellcheck'),
  autocapitalize: el.getAttribute('autocapitalize'),
  spellcheckProperty: el.spellcheck,
  autocorrectProperty: 'autocorrect' in el ? el.autocorrect : 'none',
}));

function assertNameFields(dialog, fields, labels) {
  assert.deepEqual(fields.map((field) => field.label), labels, `${dialog}: the text fields`);
  for (const field of fields) {
    assert.deepEqual(
      { autocorrect: field.autocorrect, spellcheck: field.spellcheck, autocapitalize: field.autocapitalize, spellcheckProperty: field.spellcheckProperty },
      { autocorrect: 'off', spellcheck: 'false', autocapitalize: 'off', spellcheckProperty: false },
      `${dialog}, ${field.label}: autocorrect, spellcheck and autocapitalize are off`,
    );
    // Chrome 149 has no autocorrect property. Where there is one, it must read false.
    assert.ok(field.autocorrectProperty === false || field.autocorrectProperty === 'none', `${dialog}, ${field.label}: the browser reads autocorrect as ${field.autocorrectProperty}`);
  }
}

try {
  await agent.connect(`ws://127.0.0.1:${PORT}/agent`);
  const api = await hubSession(hub.origin, PASSWORD);
  await api('POST', '/api/folders', { name: 'Work', parent_id: null });

  const errors = [];
  for (const [name, launch] of [
    ['Chromium 153', () => chromium.launch({ headless: true })],
    ['Chrome 149', launchBrowser],
  ]) {
    const browser = await launch();
    try {
      await checkBrowser(browser, `${name} ${browser.version()}`, errors);
    } finally {
      await browser.close();
    }
  }
  assert.deepEqual(errors, [], 'no page errors');
  console.log(`view inputs: ${passed.length} checks PASS`);
} finally {
  agent.close();
  hub.stop();
}

async function checkBrowser(browser, label, errors) {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (error) => errors.push(String(error)));
  await login(page, hub.origin, PASSWORD);
  await page.waitForFunction(() => document.querySelectorAll('#tree .row[data-kind="unfiled"] .dot.st-idle').length === 2);
  const closeDialog = async () => {
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#modal-root .modal-card'));
  };
  const fromMenu = async (row, item) => {
    await page.click(`${row} button[data-act="menu"]`);
    await page.click(`.menu .menu-item:text-is("${item}")`);
    await page.waitForSelector('#modal-root input.inp');
  };

  await page.click('#new-session-root');
  await page.waitForSelector('#modal-root input.inp');
  assertNameFields(`${label}, New session`, await page.evaluate(READ_INPUTS), ['Name', 'Working directory']);
  await closeDialog();
  pass(`${label}, New session: the name and working directory fields have autocorrect, spellcheck and autocapitalize off`);

  await fromMenu('#tree .row[data-kind="unfiled"][data-name="alpha"]', 'Rename session');
  assertNameFields(`${label}, Rename session`, await page.evaluate(READ_INPUTS), ['Name']);
  await closeDialog();
  pass(`${label}, Rename session: the name field has autocorrect, spellcheck and autocapitalize off`);

  await page.click('#new-folder-root');
  await page.waitForSelector('#modal-root input.inp');
  assertNameFields(`${label}, New folder`, await page.evaluate(READ_INPUTS), ['Name']);
  await closeDialog();
  await fromMenu('#tree .row[data-kind="folder"]', 'Rename folder');
  assertNameFields(`${label}, Rename folder`, await page.evaluate(READ_INPUTS), ['Name']);
  await closeDialog();
  pass(`${label}, New folder and Rename folder: the name field has autocorrect, spellcheck and autocapitalize off`);

  // Every attribute the audit covers, rendered through the view layer, then changed and removed.
  const probe = await page.evaluate(async () => {
    const { html, render } = await import('/assets/view/html.js');
    const root = document.createElement('div');
    document.body.append(root);
    const read = (el) => ({
      spellcheck: [el.getAttribute('spellcheck'), el.spellcheck],
      autocorrect: [el.getAttribute('autocorrect'), 'autocorrect' in el ? el.autocorrect : 'none'],
      translate: [el.getAttribute('translate'), el.translate],
      draggable: [el.getAttribute('draggable'), el.draggable],
      autocapitalize: [el.getAttribute('autocapitalize')],
      autocomplete: [el.getAttribute('autocomplete')],
      inputmode: [el.getAttribute('inputmode')],
      enterkeyhint: [el.getAttribute('enterkeyhint')],
      readonly: [el.getAttribute('readonly'), el.readOnly],
      'aria-invalid': [el.getAttribute('aria-invalid')],
      'data-flag': [el.getAttribute('data-flag')],
    });
    let seenRef = null;
    const ref = (el) => { seenRef = el; };
    render(html`<input ref=${ref} spellcheck="false" autocorrect="off" translate="no" draggable="false"
        autocapitalize="off" autocomplete="off" inputmode="text" enterkeyhint="done" readonly=${true}
        aria-invalid="false" data-flag="false" />`, root);
    const el = root.firstChild;
    const first = read(el);
    const refKept = seenRef === el;
    render(html`<input ref=${ref} spellcheck="true" autocorrect="on" translate="yes" draggable="true"
        autocapitalize="off" autocomplete="off" inputmode="text" enterkeyhint="done" readonly=${false}
        aria-invalid="true" data-flag="true" />`, root);
    const changed = read(root.firstChild);
    const same = root.firstChild === el;
    render(html`<input ref=${ref} spellcheck=${null} autocorrect=${null} translate=${null} draggable=${null} />`, root);
    const removed = read(root.firstChild);
    render(null, root);
    root.remove();
    return { first, changed, removed, refKept, same, refCleared: seenRef === null };
  });
  const autocorrectOff = probe.first.autocorrect[1] === 'none' ? ['off', 'none'] : ['off', false];
  assert.deepEqual(probe.first, {
    spellcheck: ['false', false], autocorrect: autocorrectOff, translate: ['no', false], draggable: ['false', false],
    autocapitalize: ['off'], autocomplete: ['off'], inputmode: ['text'], enterkeyhint: ['done'], readonly: ['true', true],
    'aria-invalid': ['false'], 'data-flag': ['false'],
  }, 'every attribute reads as written, and the browser agrees');
  assert.equal(probe.refKept, true, 'a ref the template passes still gets the element');
  assert.equal(probe.same, true, 'an update keeps the element');
  const autocorrectOn = probe.changed.autocorrect[1] === 'none' ? ['on', 'none'] : ['on', true];
  assert.deepEqual(
    { spellcheck: probe.changed.spellcheck, autocorrect: probe.changed.autocorrect, translate: probe.changed.translate, draggable: probe.changed.draggable, readonly: probe.changed.readonly, 'aria-invalid': probe.changed['aria-invalid'], 'data-flag': probe.changed['data-flag'] },
    { spellcheck: ['true', true], autocorrect: autocorrectOn, translate: ['yes', true], draggable: ['true', true], readonly: [null, false], 'aria-invalid': ['true'], 'data-flag': ['true'] },
    'an update changes each attribute',
  );
  assert.deepEqual([probe.removed.spellcheck[0], probe.removed.autocorrect[0], probe.removed.translate[0], probe.removed.draggable[0]], [null, null, null, null], 'null removes each attribute');
  assert.equal(probe.refCleared, true, 'unmounting clears the template\'s ref');
  pass(`${label}, probe: spellcheck, autocorrect, translate, draggable, autocapitalize, autocomplete, inputmode, enterkeyhint, readonly, aria-* and data-* read as written through mount, update and removal`);
}
