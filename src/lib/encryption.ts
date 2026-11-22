import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';

/**
 * Derive a 32-byte key deterministically from the configured encryption secret or app secret.
 */
function getEncryptionKey(): Buffer {
  const secret =
    process.env.WHATSAPP_TOKEN_ENCRYPTION_KEY ||
    process.env.META_APP_SECRET ||
    'gymatrix_whatsapp_default_token_encryption_key_2026';
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Encrypts an access token using AES-256-GCM.
 * Output format: iv_hex:auth_tag_hex:encrypted_hex
 */
export function encryptToken(plainText: string): string {
  if (!plainText) return '';
  const iv = crypto.randomBytes(12); // Standard 96-bit IV for AES-GCM
  const key = getEncryptionKey();
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plainText, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypts an encrypted token.
 * If the string does not follow the iv:tag:data structure, returns it as-is (e.g. unencrypted string).
 */
export function decryptToken(cipherString: string): string {
  if (!cipherString) return '';
  const parts = cipherString.split(':');
  if (parts.length !== 3) {
    return cipherString;
  }

  const [ivHex, tagHex, encryptedHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(tagHex, 'hex');
  const key = getEncryptionKey();

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

