import { createHostClient } from '@getpaseo/client/node';
import { settingsRpc } from '@getpaseo/plugin';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const id = process.argv[2] || 'web-gpt-notifier';
const home = process.env.PASEO_HOME || join(homedir(), '.paseo');
const status = JSON.parse(execFileSync('paseo', ['daemon', 'status', '--json'], { encoding: 'utf8' }));
const client = createHostClient(status.listen, {
  clientId: 'web-gpt-notifier-verification', clientType: 'cli', appVersion: status.daemonVersion,
  localCredential: async () => (await readFile(join(home, 'local-credential'), 'utf8')).trim(),
  reconnect: { enabled: false },
});
try {
  await client.connect();
  const own = (await client.getPluginCatalog()).find(plugin => plugin.id === id);
  assert.ok(own?.clientBundle, 'Compiled client bundle missing');
  const runtime = {
    '@getpaseo/plugin': require('@getpaseo/plugin'), '@getpaseo/plugin/client': {},
    '@getpaseo/plugin/client/ui': {}, react: require('react'), 'react/jsx-runtime': require('react/jsx-runtime'),
    'react-native': { Platform: { OS: 'ios' } }, zod: require('zod'),
  };
  const factory = vm.runInNewContext(own.clientBundle, { setTimeout, clearTimeout, setInterval, clearInterval, URL }, { timeout: 3000 });
  const plugin = factory(name => { assert.ok(name in runtime, 'Unexpected runtime import ' + name); return runtime[name]; });
  const registrations = [];
  const stop = plugin.default({
    addSettingsScreen: value => { registrations.push(['settings', value.id]); return () => {}; },
    addCommandCenterItem: value => { registrations.push(['command', value.id]); return () => {}; },
    addScreen: value => { registrations.push(['screen', value.id]); return () => {}; },
    addSidebarHeaderItem: value => { registrations.push(['sidebar', value.id]); return () => {}; },
    rpc: (contract, input) => client.invokePluginRpc(id, contract.name, input),
  });
  assert.equal(typeof stop, 'function'); stop();
  assert.deepEqual(registrations.map(value => value[0]), ['settings', 'command', 'screen', 'sidebar']);
  const current = await client.invokePluginRpc(id, 'monitor.status', {});
  const settings = await client.invokePluginRpc(id, settingsRpc('notifications').read.name, {});
  assert.equal(settings.status, 'ready');
  assert.equal(typeof current.configured, 'boolean');
  assert.ok(Array.isArray(current.monitors));
  await assert.rejects(() => client.invokePluginRpc(id, 'completion.notify', { id: 'invalid', url: 'https://other.example', title: 'invalid' }));
  console.log(JSON.stringify({ plugin: id, daemonVersion: status.daemonVersion, bundleLoaded: true, registrations, configured: current.configured,
    delivered: current.delivered, activeDesktopMonitors: current.monitors.filter(item => item.supported).length,
    monitoredChatGptTabs: current.monitors.filter(item => item.supported).reduce((sum, item) => sum + item.browserCount, 0),
    monitorErrors: current.monitors.filter(item => item.error).map(item => item.error),
    pageSamples: current.monitors.filter(item => item.supported).map(item => item.sample ?? null),
    invalidInputRejected: true, desktopRendering: 'not exercised by this CLI check' }, null, 2));
} finally { await client.close(); }
