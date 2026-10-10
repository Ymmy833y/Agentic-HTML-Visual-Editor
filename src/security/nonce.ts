// crypto is globally available in both the desktop extension host (Node.js) and the web extension
// host (Web Worker). Importing node:crypto would fail to resolve in the web extension host and
// break the build, so only the type is declared here.
declare const crypto: {
  getRandomValues(array: Uint8Array): Uint8Array;
};

const NONCE_LENGTH = 32;
const NONCE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Creates a single-use nonce for authorizing scripts.
 *
 * @returns A fixed-length alphanumeric string.
 */
export function createNonce(): string {
  // If the random value were predictable, the HTML being opened could include the same value and
  // defeat the policy that denies all other scripts.
  const bytes = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));

  let nonce = '';
  for (const byte of bytes) {
    nonce += NONCE_ALPHABET[byte % NONCE_ALPHABET.length];
  }
  return nonce;
}
