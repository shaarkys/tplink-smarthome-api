import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'crypto';
import http, { type IncomingHttpHeaders } from 'http';
import https from 'https';
import Queue from 'promise-queue';

import type Client from '../client';
import {
  type CredentialOptions,
  type Credentials,
  normalizeCredentialOptions,
} from '../credentials';
import type { Logger } from '../logger';
import type { ConnectionSendOptions, DeviceConnection } from './connection';

type KlapHashVersion = 'v1' | 'v2';

type KlapAuthCandidate = {
  label: string;
  version: KlapHashVersion;
  authHash: Buffer;
};

type KlapHttpResponse = {
  statusCode: number;
  body: Buffer;
  headers: IncomingHttpHeaders;
};

type KlapRequestOptions = {
  query?: Record<string, string | number>;
  cookie?: string;
};

type KlapStatusError = Error & { statusCode?: number };

type KlapEncryptionSession = {
  key: Buffer;
  ivPrefix: Buffer;
  signaturePrefix: Buffer;
  sequence: number;
};

const ONE_DAY_SECONDS = 86400;
const SESSION_EXPIRE_BUFFER_SECONDS = 60 * 20;
const SESSION_COOKIE_NAME = 'TP_SESSIONID';
const TIMEOUT_COOKIE_NAME = 'TIMEOUT';
const KLAP_PROTOCOL_PATH = '/app';
const SIGNATURE_LENGTH = 32;

const DEFAULT_CREDENTIALS_BASE64 = [
  {
    label: 'KASA',
    username: 'a2FzYUB0cC1saW5rLm5ldA==',
    password: 'a2FzYVNldHVw',
  },
  {
    label: 'TAPO',
    username: 'dGVzdEB0cC1saW5rLm5ldA==',
    password: 'dGVzdA==',
  },
];

function decodeBase64(value: string): string {
  return Buffer.from(value, 'base64').toString('utf8');
}

function parseSetCookie(headers: IncomingHttpHeaders): string[] {
  if (headers['set-cookie'] == null) return [];
  if (Array.isArray(headers['set-cookie'])) return headers['set-cookie'];
  return [headers['set-cookie']];
}

function getCookieValue(cookies: string[], name: string): string | undefined {
  for (const cookie of cookies) {
    const firstEntry = cookie.split(';')[0];
    if (firstEntry !== undefined) {
      const [cookieName, cookieValue] = firstEntry.split('=');
      if (cookieName === name && cookieValue !== undefined) {
        return cookieValue;
      }
    }
  }
  return undefined;
}

function toSignedInt32(value: number): number {
  return value > 0x7fffffff ? value - 0x100000000 : value;
}

function incrementSignedInt32(value: number): number {
  return value >= 0x7fffffff ? -0x80000000 : value + 1;
}

function signedInt32Buffer(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeInt32BE(toSignedInt32(value), 0);
  return buf;
}

function sha256(payload: Buffer): Buffer {
  return createHash('sha256').update(payload).digest();
}

function sha1(payload: Buffer): Buffer {
  return createHash('sha1').update(payload).digest();
}

function md5(payload: Buffer): Buffer {
  return createHash('md5').update(payload).digest();
}

function createKlapEncryptionSession(
  localSeed: Buffer,
  remoteSeed: Buffer,
  authHash: Buffer,
): KlapEncryptionSession {
  const key = sha256(
    Buffer.concat([
      Buffer.from('lsk', 'utf8'),
      localSeed,
      remoteSeed,
      authHash,
    ]),
  ).subarray(0, 16);

  const fullIv = sha256(
    Buffer.concat([Buffer.from('iv', 'utf8'), localSeed, remoteSeed, authHash]),
  );
  const ivPrefix = fullIv.subarray(0, 12);
  const sequence = fullIv.readInt32BE(fullIv.length - 4);

  const signaturePrefix = sha256(
    Buffer.concat([
      Buffer.from('ldk', 'utf8'),
      localSeed,
      remoteSeed,
      authHash,
    ]),
  ).subarray(0, 28);

  return { key, ivPrefix, signaturePrefix, sequence };
}

function encryptKlapPayload(
  session: KlapEncryptionSession,
  message: string,
): { payload: Buffer; seq: number } {
  const sequence = incrementSignedInt32(session.sequence);
  const seqBuffer = signedInt32Buffer(sequence);
  const iv = Buffer.concat([session.ivPrefix, seqBuffer]);
  const cipher = createCipheriv('aes-128-cbc', session.key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(message, 'utf8')),
    cipher.final(),
  ]);
  const signature = sha256(
    Buffer.concat([session.signaturePrefix, seqBuffer, ciphertext]),
  );
  return {
    payload: Buffer.concat([signature, ciphertext]),
    seq: sequence,
  };
}

function decryptKlapPayload(
  session: KlapEncryptionSession,
  message: Buffer,
  seq: number,
): string {
  if (message.length < SIGNATURE_LENGTH) {
    throw new Error('KLAP response payload is too short');
  }
  const iv = Buffer.concat([session.ivPrefix, signedInt32Buffer(seq)]);
  const decipher = createDecipheriv('aes-128-cbc', session.key, iv);
  const plaintext = Buffer.concat([
    decipher.update(message.subarray(SIGNATURE_LENGTH)),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

/**
 * @hidden
 */
export default class KlapConnection implements DeviceConnection {
  private readonly queue = new Queue(1, Infinity);

  private readonly credentials?: Credentials;

  private readonly credentialsHash?: string;

  private session?: KlapEncryptionSession;

  private sessionCookie?: string;

  private sessionExpiresAt = 0;

  constructor(
    public host: string,
    public port: number,
    readonly log: Logger,
    readonly client: Client,
    credentialOptions?: CredentialOptions,
  ) {
    const normalizedCredentials = normalizeCredentialOptions(
      credentialOptions,
      'klap connection credentials',
    );
    this.credentials = normalizedCredentials.credentials;
    this.credentialsHash = normalizedCredentials.credentialsHash;
  }

  private get description(): string {
    return `KLAP ${this.host}:${this.port}`;
  }

  private resetSession(): void {
    this.session = undefined;
    this.sessionCookie = undefined;
    this.sessionExpiresAt = 0;
  }

  private isSessionExpired(): boolean {
    return this.sessionExpiresAt === 0 || Date.now() >= this.sessionExpiresAt;
  }

  private static authHashV1(credentials: Credentials): Buffer {
    return md5(
      Buffer.concat([
        md5(Buffer.from(credentials.username, 'utf8')),
        md5(Buffer.from(credentials.password, 'utf8')),
      ]),
    );
  }

  private static authHashV2(credentials: Credentials): Buffer {
    return sha256(
      Buffer.concat([
        sha1(Buffer.from(credentials.username, 'utf8')),
        sha1(Buffer.from(credentials.password, 'utf8')),
      ]),
    );
  }

  private buildAuthCandidates(): KlapAuthCandidate[] {
    const candidates: KlapAuthCandidate[] = [];
    const seen = new Set<string>();
    const addCandidate = (
      label: string,
      version: KlapHashVersion,
      authHash: Buffer,
    ): void => {
      const key = `${version}:${authHash.toString('hex')}`;
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push({ label, version, authHash });
      }
    };

    if (this.credentialsHash !== undefined) {
      let decodedHash: Buffer;
      try {
        decodedHash = Buffer.from(this.credentialsHash, 'base64');
      } catch (err) {
        throw new TypeError(
          'credentialsHash must be a valid base64 encoded KLAP auth hash',
        );
      }
      if (decodedHash.length === 0) {
        throw new TypeError(
          'credentialsHash must be a valid base64 encoded KLAP auth hash',
        );
      }
      addCandidate('credentialsHash', 'v2', decodedHash);
      addCandidate('credentialsHash', 'v1', decodedHash);
    }

    const addCredentialPair = (label: string, creds: Credentials): void => {
      addCandidate(label, 'v2', KlapConnection.authHashV2(creds));
      addCandidate(label, 'v1', KlapConnection.authHashV1(creds));
    };

    if (this.credentials != null) {
      addCredentialPair('credentials', this.credentials);
    }

    DEFAULT_CREDENTIALS_BASE64.forEach((defaultCredential) => {
      addCredentialPair(defaultCredential.label, {
        username: decodeBase64(defaultCredential.username),
        password: decodeBase64(defaultCredential.password),
      });
    });

    addCredentialPair('blank', { username: '', password: '' });

    return candidates;
  }

  private static handshake1SeedAuthHash(
    localSeed: Buffer,
    remoteSeed: Buffer,
    authHash: Buffer,
    version: KlapHashVersion,
  ): Buffer {
    if (version === 'v1') {
      return sha256(Buffer.concat([localSeed, authHash]));
    }
    return sha256(Buffer.concat([localSeed, remoteSeed, authHash]));
  }

  private static handshake2SeedAuthHash(
    localSeed: Buffer,
    remoteSeed: Buffer,
    authHash: Buffer,
    version: KlapHashVersion,
  ): Buffer {
    if (version === 'v1') {
      return sha256(Buffer.concat([remoteSeed, authHash]));
    }
    return sha256(Buffer.concat([remoteSeed, localSeed, authHash]));
  }

  private selectAuthCandidate(
    localSeed: Buffer,
    remoteSeed: Buffer,
    serverHash: Buffer,
  ): KlapAuthCandidate {
    for (const candidate of this.buildAuthCandidates()) {
      const challenge = KlapConnection.handshake1SeedAuthHash(
        localSeed,
        remoteSeed,
        candidate.authHash,
        candidate.version,
      );
      if (challenge.equals(serverHash)) {
        this.log.debug(
          'KlapConnection(%s): matched handshake challenge (%s/%s)',
          this.description,
          candidate.label,
          candidate.version,
        );
        return candidate;
      }
    }

    throw new Error(
      `KlapConnection(${this.description}): authentication failed (challenge mismatch)`,
    );
  }

  private async ensureSession(timeout: number): Promise<void> {
    if (this.session !== undefined && !this.isSessionExpired()) {
      return;
    }

    this.resetSession();
    const localSeed = randomBytes(16);
    const handshake1Response = await this.post(
      `${KLAP_PROTOCOL_PATH}/handshake1`,
      localSeed,
      timeout,
    );

    if (handshake1Response.statusCode !== 200) {
      throw new Error(
        `KlapConnection(${this.description}): handshake1 failed with status ${handshake1Response.statusCode}`,
      );
    }

    const responseData = handshake1Response.body;
    if (responseData.length < 48) {
      throw new Error(
        `KlapConnection(${this.description}): handshake1 response is invalid`,
      );
    }

    const remoteSeed = responseData.subarray(0, 16);
    const serverHash = responseData.subarray(16);
    if (serverHash.length !== 32) {
      throw new Error(
        `KlapConnection(${this.description}): handshake1 hash length is invalid`,
      );
    }

    const matchedCandidate = this.selectAuthCandidate(
      localSeed,
      remoteSeed,
      serverHash,
    );
    const handshake2Payload = KlapConnection.handshake2SeedAuthHash(
      localSeed,
      remoteSeed,
      matchedCandidate.authHash,
      matchedCandidate.version,
    );

    const setCookies = parseSetCookie(handshake1Response.headers);
    const timeoutCookie = getCookieValue(setCookies, TIMEOUT_COOKIE_NAME);
    const timeoutSeconds =
      timeoutCookie !== undefined
        ? parseInt(timeoutCookie, 10)
        : ONE_DAY_SECONDS;
    const sessionId = getCookieValue(setCookies, SESSION_COOKIE_NAME);
    const cookieHeader =
      sessionId !== undefined
        ? `${SESSION_COOKIE_NAME}=${sessionId}`
        : undefined;

    const handshake2Response = await this.post(
      `${KLAP_PROTOCOL_PATH}/handshake2`,
      handshake2Payload,
      timeout,
      { cookie: cookieHeader },
    );
    if (handshake2Response.statusCode !== 200) {
      throw new Error(
        `KlapConnection(${this.description}): handshake2 failed with status ${handshake2Response.statusCode}`,
      );
    }

    const adjustedSessionSeconds = Math.max(
      1,
      (Number.isNaN(timeoutSeconds) ? ONE_DAY_SECONDS : timeoutSeconds) -
        SESSION_EXPIRE_BUFFER_SECONDS,
    );

    this.session = createKlapEncryptionSession(
      localSeed,
      remoteSeed,
      matchedCandidate.authHash,
    );
    this.sessionCookie = cookieHeader;
    this.sessionExpiresAt = Date.now() + adjustedSessionSeconds * 1000;
  }

  private async sendEncryptedRequest(
    payload: string,
    timeout: number,
  ): Promise<string> {
    if (this.session === undefined) {
      throw new Error(
        `KlapConnection(${this.description}): session is not initialized`,
      );
    }

    const encrypted = encryptKlapPayload(this.session, payload);
    this.session.sequence = encrypted.seq;
    const requestResponse = await this.post(
      `${KLAP_PROTOCOL_PATH}/request`,
      encrypted.payload,
      timeout,
      {
        query: { seq: encrypted.seq },
        cookie: this.sessionCookie,
      },
    );

    if (requestResponse.statusCode === 403) {
      const retryableError: KlapStatusError = new Error(
        `KlapConnection(${this.description}): request rejected by device security policy`,
      );
      retryableError.statusCode = 403;
      throw retryableError;
    }

    if (requestResponse.statusCode !== 200) {
      throw new Error(
        `KlapConnection(${this.description}): request failed with status ${requestResponse.statusCode}`,
      );
    }

    return decryptKlapPayload(
      this.session,
      requestResponse.body,
      encrypted.seq,
    );
  }

  private isHttpsRequest(): boolean {
    return this.port === 443 || this.port === 4433;
  }

  private async post(
    path: string,
    data: Buffer,
    timeout: number,
    options: KlapRequestOptions = {},
  ): Promise<KlapHttpResponse> {
    const querySearchParams = new URLSearchParams();
    if (options.query !== undefined) {
      Object.entries(options.query).forEach(([key, value]) => {
        querySearchParams.append(key, String(value));
      });
    }
    const queryString = querySearchParams.toString();
    const query = queryString.length > 0 ? `?${queryString}` : '';
    const requestPath = `${path}${query}`;
    const headers: Record<string, string | number> = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': data.length,
      Connection: 'keep-alive',
    };
    if (options.cookie !== undefined) {
      headers.Cookie = options.cookie;
    }

    return new Promise((resolve, reject) => {
      const requestOptions: https.RequestOptions = {
        host: this.host,
        port: this.port,
        method: 'POST',
        path: requestPath,
        headers,
      };
      if (this.isHttpsRequest()) {
        requestOptions.rejectUnauthorized = false;
      }

      const request = (this.isHttpsRequest() ? https : http).request(
        requestOptions,
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer | string) => {
            chunks.push(
              typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk,
            );
          });
          response.on('end', () => {
            resolve({
              statusCode: response.statusCode ?? 0,
              body: Buffer.concat(chunks),
              headers: response.headers,
            });
          });
        },
      );

      request.setTimeout(timeout, () => {
        request.destroy(
          new Error(
            `KlapConnection(${this.description}): timeout after ${timeout}ms`,
          ),
        );
      });

      request.on('error', (error) => {
        reject(error);
      });

      request.write(data);
      request.end();
    });
  }

  async send(
    payload: string,
    port: number,
    host: string,
    options: ConnectionSendOptions,
  ): Promise<string> {
    this.host = host;
    this.port = port;
    const { timeout } = options;

    return this.queue.add(async () => {
      try {
        await this.ensureSession(timeout);
        return await this.sendEncryptedRequest(payload, timeout);
      } catch (error) {
        const statusCode =
          typeof error === 'object' &&
          error !== null &&
          'statusCode' in error &&
          typeof (error as KlapStatusError).statusCode === 'number'
            ? (error as KlapStatusError).statusCode
            : undefined;
        if (statusCode === 403) {
          this.resetSession();
          await this.ensureSession(timeout);
          return this.sendEncryptedRequest(payload, timeout);
        }
        throw error;
      }
    });
  }

  close(): void {
    this.resetSession();
  }
}
