// ABOUTME: Shared cryptographic utilities
// ABOUTME: Timing-safe string comparison using crypto.subtle.timingSafeEqual

const encoder = new TextEncoder();

export function timingSafeCompare(a: string, b: string): boolean {
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}
