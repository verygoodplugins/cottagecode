/** Public builds declare their mode in HTML, never in query strings or storage. */
export function isPublicDemoDocument(doc = globalThis.document) {
  return Boolean(doc?.documentElement?.dataset?.cottagecodeMode === 'public-demo' ||
    doc?.querySelector?.('meta[name="cottagecode-mode"]')?.content === 'public-demo');
}

// Capture the mode once, before any URL handling or connection controls run.
export const PUBLIC_DEMO = Boolean(isPublicDemoDocument());
