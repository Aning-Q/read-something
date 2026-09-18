import { SyncError } from './types';

// Envelope format: "RSENC1" magic | 16-byte salt | 12-byte iv | AES-GCM ciphertext
const MAGIC = new Uint8Array([0x52, 0x53, 0x45, 0x4e, 0x43, 0x31]);
const SALT_BYTES = 16;
const IV_BYTES = 12;
const PBKDF2_ITERATIONS = 210_000;
const HEADER_BYTES = MAGIC.length + SALT_BYTES + IV_BYTES;

const encoder = new TextEncoder();

const getCrypto = (): Crypto => {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new SyncError('当前浏览器不支持 WebCrypto，无法进行客户端加密');
  }
  return crypto;
};

const deriveKey = async (password: string, salt: Uint8Array): Promise<CryptoKey> => {
  const subtle = getCrypto().subtle;
  const baseKey = await subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
};

export const isEncryptedPayload = async (blob: Blob): Promise<boolean> => {
  if (blob.size < HEADER_BYTES) return false;
  const header = new Uint8Array(await blob.slice(0, MAGIC.length).arrayBuffer());
  return MAGIC.every((byte, index) => header[index] === byte);
};

export const encryptBlob = async (blob: Blob, password: string): Promise<Blob> => {
  if (!password) throw new SyncError('同步密码不能为空');
  const subtle = getCrypto().subtle;
  const salt = new Uint8Array(SALT_BYTES);
  const iv = new Uint8Array(IV_BYTES);
  getCrypto().getRandomValues(salt);
  getCrypto().getRandomValues(iv);

  const key = await deriveKey(password, salt);
  const plaintext = new Uint8Array(await blob.arrayBuffer());
  const ciphertext = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv: iv as unknown as BufferSource }, key, plaintext as unknown as BufferSource)
  );

  const output = new Uint8Array(HEADER_BYTES + ciphertext.length);
  output.set(MAGIC, 0);
  output.set(salt, MAGIC.length);
  output.set(iv, MAGIC.length + SALT_BYTES);
  output.set(ciphertext, HEADER_BYTES);
  return new Blob([output], { type: 'application/octet-stream' });
};

export const decryptBlob = async (blob: Blob, password: string): Promise<Blob> => {
  if (!password) throw new SyncError('该存档已加密，请输入同步密码');
  if (!(await isEncryptedPayload(blob))) {
    throw new SyncError('存档不是本应用生成的加密格式');
  }
  const subtle = getCrypto().subtle;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const salt = bytes.slice(MAGIC.length, MAGIC.length + SALT_BYTES);
  const iv = bytes.slice(MAGIC.length + SALT_BYTES, HEADER_BYTES);
  const ciphertext = bytes.slice(HEADER_BYTES);

  const key = await deriveKey(password, salt);
  try {
    const plaintext = await subtle.decrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource },
      key,
      ciphertext as unknown as BufferSource
    );
    return new Blob([plaintext], { type: 'application/gzip' });
  } catch {
    throw new SyncError('同步密码错误，或云端存档已损坏');
  }
};
