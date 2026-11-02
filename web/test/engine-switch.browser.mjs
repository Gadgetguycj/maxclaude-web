// Scripted responses exercise the browser and hub contract, never a product path.
import assert from 'node:assert/strict';
import { ScriptedAgent, startHub, launchBrowser, login } from './view-harness.mjs';
class EngineAgent extends ScriptedAgent {
  sessions() {
    return super.sessions().map(row => ({...row, engine: this.rows.get(row.name).engine || 'claude'}));
  }
  onReq(msg) {
    if (msg.method !== 'sessions.setEngine') return super.onReq(msg);
    const {name, engine} = msg.params;
    this.calls.push({name, engine});
    if (this.error) return this.refuse(msg, 'conflict', 'Switching engines requires exactly one running engine pane');
    this.set(name, {engine});
    this.reply(msg, {name, engine, changed: true});
    this.push();
  }
}
const secret = 'engine-contract-test', password = 'engine-contract-test';
const hub = await startHub({port: 18450, secret, password});
const agent = new EngineAgent(secret, ['example']);
agent.calls = [];
let browser;
try {
  await agent.connect(hub.origin.replace('http', 'ws') + '/agent');
  // Use the unfiled session menu so no saved tree is needed for switching.
  browser = await launchBrowser();
  const page = await browser.newPage({viewport: {width: 1440, height: 900}});
  await login(page, hub.origin, password);
  const row = page.locator('#tree .row[data-kind="unfiled"][data-name="example"]');
  await row.waitFor();
  await row.click();
  await row.locator('[data-act="menu"]').click();
  await page.getByRole('menuitem', {name: 'Switch to Codex', exact: true}).click();
  await row.locator('.engine-label').waitFor();
  await page.locator('#term-title .engine-label').waitFor();
  assert.deepEqual(agent.calls, [{name: 'example', engine: 'codex'}]);
  assert.equal(await row.locator('.dot').getAttribute('class'), 'dot st-unknown');
  await row.locator('[data-act="menu"]').click();
  await page.getByRole('menuitem', {name: 'Switch to Claude', exact: true}).click();
  await row.locator('.engine-label').waitFor({state: 'detached'});
  assert.deepEqual(agent.calls.at(-1), {name: 'example', engine: 'claude'});
  agent.error = true;
  await row.locator('[data-act="menu"]').click();
  await page.getByRole('menuitem', {name: 'Switch to Codex', exact: true}).click();
  await page.getByText('Switching engines requires exactly one running engine pane', {exact: true}).waitFor();
  assert.equal(await row.locator('.engine-label').count(), 0);
  console.log('Engine menu, hub RPC, labels, neutral status, return switch and conflict handling passed');
} finally {
  await browser?.close();
  agent.close();
  hub.stop();
}
