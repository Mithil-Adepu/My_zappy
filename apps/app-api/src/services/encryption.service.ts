import crypto from 'crypto';
import { env } from '../config/env';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits — recommended for GCM
const TAG_LENGTH = 16;

function getKey(): Buffer {
  return Buffer.from(env.ENCRYPTION_KEY, 'hex');
}

/**
 * Encrypts a plaintext string using AES-256-GCM.
 * Returns a base64-encoded string: iv + authTag + ciphertext
 */
export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  // Format: [12B iv][16B tag][ciphertext]
  const result = Buffer.concat([iv, tag, encrypted]);
  return result.toString('base64');
}

/**
 * Decrypts a base64-encoded AES-256-GCM ciphertext.
 */
export function decrypt(encoded: string): string {
  const data = Buffer.from(encoded, 'base64');

  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(tag);

  return (
    decipher.update(ciphertext).toString('utf8') +
    decipher.final('utf8')
  );
}
