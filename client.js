/**
 * dsh-pluginhub — Client plugin entry point (Web UI)
 *
 * This module is loaded by the DSH Web client to render the
 * PluginHub control panel in the Harness sidebar/layout.
 */

// TODO: Implement Solid.js / React client panel
// - Topology view: plugin/agent relationship graph + health status
// - Detail view: manifest source, capability list, schema forms
// - Realtime view: event stream, log stream, trace waterfall

export function mount(container, ctx) {
  container.innerHTML = '<div data-pluginhub-panel>PluginHub panel loading…</div>'

  return () => {
    container.innerHTML = ''
  }
}
