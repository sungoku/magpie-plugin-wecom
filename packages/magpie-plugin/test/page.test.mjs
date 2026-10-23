import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const pluginDir = path.resolve(here, '..');
const pageDir = path.join(pluginDir, 'page');

const html = fs.readFileSync(path.join(pageDir, 'index.html'), 'utf-8');
const app = fs.readFileSync(path.join(pageDir, 'app.js'), 'utf-8');

test('the page has no inline scripts or inline event handlers (Magpie CSP)', () => {
  // script-src only allows files in the page's own folder.
  assert.doesNotMatch(html, /<script\b(?![^>]*\bsrc=)[^>]*>/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /javascript:/i);
});

test('the page loads only its own assets, never a CDN', () => {
  assert.doesNotMatch(html, /\b(?:src|href)\s*=\s*["'](?:https?:)?\/\//i);
  assert.match(html, /<script src="_magpie\/bridge\.js"><\/script>/);
  assert.match(html, /<script src="app\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="style\.css">/);
  assert.match(html, /<link rel="icon" href="icon\.svg" type="image\/svg\+xml">/);
  assert.ok(fs.existsSync(path.join(pageDir, 'app.js')));
  assert.ok(fs.existsSync(path.join(pageDir, 'style.css')));
  assert.ok(fs.existsSync(path.join(pageDir, 'icon.svg')));
});

test('the page icon is a self-contained SVG', () => {
  const icon = fs.readFileSync(path.join(pageDir, 'icon.svg'), 'utf-8');
  assert.match(icon, /^<svg[\s>]/);
  assert.doesNotMatch(icon, /\b(?:href|src)\s*=\s*["']https?:/i);
  assert.doesNotMatch(icon, /@import|url\(/i);
});

test('scripts avoid APIs a sandboxed frame blocks', () => {
  assert.doesNotMatch(app, /\balert\s*\(/);
  assert.doesNotMatch(app, /\bconfirm\s*\(/);
  assert.doesNotMatch(app, /\bprompt\s*\(/);
  assert.doesNotMatch(app, /\blocalStorage\b/);
  assert.doesNotMatch(app, /\bsessionStorage\b/);
  assert.doesNotMatch(app, /document\.cookie/);
});

test('the page has a Magpie mode that never calls the local API', () => {
  assert.match(app, /function initMagpie\s*\(/);
  assert.match(app, /function initStandalone\s*\(/);
  // A regression here means the page tries to fetch inside Magpie's
  // connect-src 'none' frame and silently does nothing.
  const magpieBody = app.slice(app.indexOf('function initMagpie'), app.indexOf('function initStandalone'));
  assert.doesNotMatch(magpieBody, /\bfetch\s*\(/);
});

test('package manifests point at the page and the Bun hooks module', () => {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
  const pluginPkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf-8'));

  for (const pkg of [rootPkg, pluginPkg]) {
    assert.ok(pkg.magpie.page.file.endsWith('index.html'));
    assert.ok(pkg.magpie.hooks.endsWith('wecom.hooks.js'));
    assert.equal(pkg.magpie.middleware, undefined);
    assert.equal(pkg.magpie.options.autoStartService?.type, 'boolean');
    assert.equal(
      pkg.magpie.options.autoStartService?.default,
      false,
      'auto-starting a credentialed gateway must stay opt-in'
    );
    assert.equal(pkg.magpie.options.approvalWaitSec?.type, 'number');
    assert.equal(pkg.magpie.options.approvalWaitSec?.default, 10);
  }

  assert.ok(fs.existsSync(path.join(pluginDir, 'wecom.hooks.js')));
  assert.ok(!fs.existsSync(path.join(pluginDir, 'wecom.middleware.js')));

  const rootPage = path.resolve(root, rootPkg.magpie.page.file);
  assert.ok(fs.existsSync(rootPage));
  assert.ok(fs.existsSync(path.resolve(root, rootPkg.magpie.hooks)));
  assert.ok(fs.existsSync(path.resolve(pluginDir, pluginPkg.magpie.page.file)));
  assert.ok(fs.existsSync(path.resolve(pluginDir, pluginPkg.magpie.hooks)));

  // Magpie only serves an icon that lives in the page's own folder.
  for (const [base, pkg] of [[root, rootPkg], [pluginDir, pluginPkg]]) {
    const icon = path.resolve(base, pkg.magpie.page.icon);
    assert.ok(fs.existsSync(icon), `icon must exist: ${pkg.magpie.page.icon}`);
    assert.equal(path.dirname(icon), path.resolve(base, path.dirname(pkg.magpie.page.file)));
  }
});

test('the OpenCode entry exists so page option saves restart the Bun host', async () => {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
  const pluginPkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf-8'));

  // Magpie's SetPageOptions skips the restart when the package has no
  // main/exports. These hooks read their options at host startup, so the
  // entry is what makes "保存通知设置" take effect.
  for (const [base, pkg] of [[root, rootPkg], [pluginDir, pluginPkg]]) {
    assert.ok(pkg.main, 'manifest must declare main');
    assert.ok(pkg.main.endsWith('wecom.plugin.js'), 'main must be the no-op entry');
    assert.ok(!pkg.main.endsWith('wecom.hooks.js'), 'the host must not call the hooks as an OpenCode plugin');
    assert.ok(fs.existsSync(path.resolve(base, pkg.main)), `main must exist: ${pkg.main}`);
  }

  const mod = await import(pathToFileURL(path.resolve(root, rootPkg.main)).href);
  assert.equal(typeof mod.default, 'function');
  assert.deepEqual(await mod.default(), {});
  assert.deepEqual(await mod.default(undefined, {}), {});
});

test('the gateway auto-start helper ships with the plugin and stays opt-in', async () => {
  assert.ok(fs.existsSync(path.join(pluginDir, 'service.js')));

  const mod = await import(pathToFileURL(path.join(pluginDir, 'service.js')).href);
  for (const name of ['ensureService', 'isServiceHealthy', 'findGateway', 'serviceTarget']) {
    assert.equal(typeof mod[name], 'function', `${name} must be exported`);
  }

  // No option, no process. A remote notify URL is not a local service either.
  assert.equal(await mod.ensureService({}), false);
  assert.equal(
    await mod.ensureService({ autoStartService: true, notifyUrl: 'http://example.com/notify' }),
    false
  );
});
