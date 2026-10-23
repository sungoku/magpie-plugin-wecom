/**
 * OpenCode v1 plugin entry for Magpie.
 *
 * Magpie decides whether a package is "page-only" by looking for `main` /
 * `exports` only (plugin.Window), and `plugin.SetPageOptions` skips the host
 * restart for such a package. This plugin also ships `magpie.hooks`, so its
 * notification options live in the Bun host, which reads them once when it
 * starts. Without an entry here, saving the options from the plugin page
 * would update plugins.json but leave the running hooks on their old values.
 *
 * Declaring this entry makes Magpie take the normal `SetOptions` path, which
 * restarts the host, so the page's save button applies immediately. Magpie
 * hands a plugin its options as the second argument; this entry uses them to
 * start the local gateway when the user enabled `autoStartService`.
 */
import { ensureService } from './service.js';

export default async function wecomBridgePlugin(_input, options) {
  await ensureService(options || {}, { force: true });
  return {};
}
