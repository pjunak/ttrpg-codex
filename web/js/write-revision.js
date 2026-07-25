const OFFSET = 0xcbf29ce484222325n;
const PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;

export function writeRevision(value) {
  const text = JSON.stringify(value) ?? 'undefined';
  let hash = OFFSET;
  for (let index = 0; index < text.length; index++) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, '0');
}
