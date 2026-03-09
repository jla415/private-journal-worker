// ABOUTME: Vitest setup file that polyfills Cloudflare Workers APIs not available in Node.js
// ABOUTME: Currently polyfills crypto.subtle.timingSafeEqual

import { timingSafeEqual } from 'node:crypto';

// Polyfill crypto.subtle.timingSafeEqual (Cloudflare Workers API, not in Node.js)
if (!crypto.subtle.timingSafeEqual) {
  (crypto.subtle as any).timingSafeEqual = (a: ArrayBuffer, b: ArrayBuffer): boolean => {
    if (a.byteLength !== b.byteLength) {
      throw new TypeError('Input buffers must have the same byte length');
    }
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  };
}
