import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

export const newToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export const MIN_PASSWORD = 10;
export const hashPassword = (pw: string) => hash(pw);
export async function verifyPassword(hashStr: string | null, pw: string): Promise<boolean> {
  if (!hashStr) return false;
  try {
    return await verify(hashStr, pw);
  } catch {
    return false;
  }
}
