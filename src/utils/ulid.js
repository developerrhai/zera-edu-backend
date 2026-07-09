const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ENCODING_LEN = 32;

/**
 * Encodes time part into Crockford's Base32 string.
 */
function encodeTime(now, len) {
  let str = "";
  for (let i = len - 1; i >= 0; i--) {
    const mod = now % ENCODING_LEN;
    str = ENCODING.charAt(mod) + str;
    now = Math.floor(now / ENCODING_LEN);
  }
  return str;
}

/**
 * Encodes random part into Crockford's Base32 string.
 */
function encodeRandom(len) {
  let str = "";
  for (let i = 0; i < len; i++) {
    const rand = Math.floor(Math.random() * ENCODING_LEN);
    str += ENCODING.charAt(rand);
  }
  return str;
}

/**
 * Generates a 26-character Universally Unique Lexicographically Sortable Identifier (ULID).
 */
function generateUlid() {
  const now = Date.now();
  return encodeTime(now, 10) + encodeRandom(16);
}

module.exports = { generateUlid };
