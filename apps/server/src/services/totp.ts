import { Secret, TOTP } from 'otpauth';
import QRCode from 'qrcode';

const make = (secretB32: string, label = '') =>
  new TOTP({ issuer: 'MyWineCorks', label, algorithm: 'SHA1', digits: 6, period: 30, secret: Secret.fromBase32(secretB32) });

export function newTotpSecret(): string {
  return new Secret({ size: 20 }).base32;
}

export async function totpSetupInfo(secretB32: string, label: string) {
  const uri = make(secretB32, label).toString();
  return { secret: secretB32, uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) };
}

/** Accepts the current code and one step either side (clock drift). */
export function checkTotp(secretB32: string, code: string): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  return make(secretB32).validate({ token: code, window: 1 }) !== null;
}

export function currentTotp(secretB32: string): string {
  return make(secretB32).generate();
}
