// 安全模块：AES-GCM 加密 + Token + 密码哈希
// 对应原 Go 项目 internal/security/security.go
// 主密钥来自 Worker Secrets (CDT_MASTER_KEY)，32 字节 base64

const ENCRYPTED_PREFIX = 'enc:v1:';

// 从环境变量获取主密钥（32 字节 base64 编码）
export function getMasterKey(env: Env): Uint8Array {
  const raw = env.CDT_MASTER_KEY;
  if (!raw) throw new Error('CDT_MASTER_KEY secret is not configured');
  const decoded = base64UrlDecode(raw);
  if (decoded.length !== 32) throw new Error('master key must be 32 bytes');
  return decoded;
}

function base64UrlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function importAesKey(key: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encrypt(env: Env, plaintext: string): Promise<string> {
  if (!plaintext || plaintext.startsWith(ENCRYPTED_PREFIX)) return plaintext;
  const key = await importAesKey(getMasterKey(env));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, enc.encode(plaintext));
  const combined = new Uint8Array(nonce.length + sealed.byteLength);
  combined.set(nonce);
  combined.set(new Uint8Array(sealed), nonce.length);
  return ENCRYPTED_PREFIX + base64UrlEncode(combined);
}

export async function decrypt(env: Env, value: string): Promise<string> {
  if (!value || !value.startsWith(ENCRYPTED_PREFIX)) return value;
  const raw = base64UrlDecode(value.slice(ENCRYPTED_PREFIX.length));
  if (raw.length < 12) throw new Error('invalid encrypted value');
  const key = await importAesKey(getMasterKey(env));
  const nonce = raw.slice(0, 12);
  const ciphertext = raw.slice(12);
  const dec = new TextDecoder();
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ciphertext);
  return dec.decode(plain);
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(ENCRYPTED_PREFIX);
}

// 生成随机 token（等价 NewToken）
export function newToken(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return base64UrlEncode(buf);
}

export async function tokenHash(token: string): Promise<string> {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(token));
  return base64UrlEncode(new Uint8Array(digest));
}

// 密码哈希：Worker 无原生 Argon2，用 PBKDF2（SHA-256, 60k 迭代）替代
// 与原 Go 项目的 Argon2id 语义等价（都用于管理员密码的单向哈希）
const PBKDF2_ITERATIONS = 60000;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 10) throw new Error('password must be at least 10 characters');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256,
  );
  const hash = new Uint8Array(bits);
  return `$pbkdf2-sha256$i=${PBKDF2_ITERATIONS}$${base64UrlEncode(salt)}$${base64UrlEncode(hash)}`;
}

export async function verifyPassword(encoded: string, password: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 4 || parts[1] !== 'pbkdf2-sha256') {
    return false;
  }
  const iterMatch = /^i=(\d+)$/.exec(parts[2]);
  if (!iterMatch) return false;
  const iterations = parseInt(iterMatch[1], 10);
  const salt = base64UrlDecode(parts[3]);
  const expected = base64UrlDecode(parts[4]);
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    expected.length * 8,
  );
  const actual = new Uint8Array(bits);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

// 环境变量类型声明
export interface Env {
  DB: D1Database;
  CDT_MASTER_KEY: string;
}
