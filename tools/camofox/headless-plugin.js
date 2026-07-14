/**
 * headless plugin: force Camoufox to launch headless by making the virtual
 * display factory throw SYNCHRONOUSLY. On this box Xvfb starts but never
 * reports a display; the failure surfaces async, past server.js's try/catch,
 * so the built-in headless fallback is unreachable (DISPLAY ends up
 * "[object Promise]" → SIGBUS). The ctx factory is explicitly overridable.
 */
export async function register(app, ctx) {
  ctx.createVirtualDisplay = () => {
    throw new Error('headless plugin: virtual display disabled on this host');
  };
  ctx.log('info', 'headless plugin: virtual display disabled — camoufox will launch headless');
}
