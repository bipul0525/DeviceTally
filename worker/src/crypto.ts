const enc = new TextEncoder()

export const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const fromB64url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

export const randomToken = (bytes = 32) => b64url(crypto.getRandomValues(new Uint8Array(bytes)))

export const sha256 = async (s: string) => b64url(await crypto.subtle.digest('SHA-256', enc.encode(s)))

// 100,000 is the Workers maximum (Phase 0).
export const PBKDF2_ITERATIONS = 100_000

async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256)
}

export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64url(salt)}$${b64url(await pbkdf2(password, salt, PBKDF2_ITERATIONS))}`
}

export async function verifyPassword(password: string, stored: string) {
  const [scheme, it, salt, hash] = stored.split('$')
  if (scheme !== 'pbkdf2') return false
  const got = new Uint8Array(await pbkdf2(password, fromB64url(salt), Number(it)))
  const want = fromB64url(hash)
  return got.length === want.length && sameBytes(got, want)
}

/** Constant-time comparison: Cloudflare's crypto.subtle.timingSafeEqual, or the same in plain code on Node. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?(a: Uint8Array, b: Uint8Array): boolean }
  if (subtle.timingSafeEqual) return subtle.timingSafeEqual(a, b)
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

// Enrollment codes: no 0/O/1/I/L to avoid misreading.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
export const enrollCode = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')
