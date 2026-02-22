import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  generateKeyPairSync,
  privateDecrypt,
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

type AesHttpResponse = {
  statusCode: number;
  body: string;
  headers: IncomingHttpHeaders;
};

type AesRequestOptions = {
  headers?: Record<string, string>;
  cookie?: string;
};

type AesStatusError = Error & {
  statusCode?: number;
  errorCode?: number;
};

type AesEncryptionSession = {
  key: Buffer;
  iv: Buffer;
};

type AesLoginParams = {
  username: string;
  password?: string;
  password2?: string;
};

type AesLoginCandidate = {
  label: string;
  params: AesLoginParams;
};

const ONE_DAY_SECONDS = 86400;
const SESSION_EXPIRE_BUFFER_SECONDS = 60 * 20;
const SESSION_COOKIE_NAME = 'TP_SESSIONID';
const SESSION_COOKIE_NAME_FALLBACK = 'SESSIONID';
const TIMEOUT_COOKIE_NAME = 'TIMEOUT';
const AES_PROTOCOL_PATH = '/app';

const AES_AUTH_ERROR_CODES = new Set([
  -1501, // LOGIN_ERROR
  1111, // LOGIN_FAILED_ERROR
  -1005, // AES_DECODE_FAIL_ERROR
  1100, // HAND_SHAKE_FAILED_ERROR
  1003, // TRANSPORT_UNKNOWN_CREDENTIALS_ERROR
  -40412, // HOMEKIT_LOGIN_FAIL
]);

const DEFAULT_TAPO_CREDENTIAL_BASE64 = {
  username: 'dGVzdEB0cC1saW5rLm5ldA==',
  password: 'dGVzdA==',
};

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

function isObjectLike(
  candidate: unknown,
): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null;
}

function sha1Hex(payload: string): string {
  return createHash('sha1').update(payload, 'utf8').digest('hex');
}

function base64EncodeString(payload: string): string {
  return Buffer.from(payload, 'utf8').toString('base64');
}

function encryptAesPayload(
  session: AesEncryptionSession,
  payload: string,
): string {
  const cipher = createCipheriv('aes-128-cbc', session.key, session.iv);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(payload, 'utf8')),
    cipher.final(),
  ]);
  return encrypted.toString('base64');
}

function decryptAesPayload(
  session: AesEncryptionSession,
  payload: string,
): string {
  const decipher = createDecipheriv('aes-128-cbc', session.key, session.iv);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

function decryptPkcs1v15(
  privateKeyPem: string,
  encryptedPayload: Buffer,
): Buffer {
  const decryptedBlock = privateDecrypt(
    {
      key: privateKeyPem,
      padding: constants.RSA_NO_PADDING,
    },
    encryptedPayload,
  );
  if (decryptedBlock.length < 11) {
    throw new Error('PKCS#1 block too short');
  }
  if (decryptedBlock[0] !== 0x00 || decryptedBlock[1] !== 0x02) {
    throw new Error('Invalid PKCS#1 block prefix');
  }

  let separatorIndex = -1;
  for (let index = 2; index < decryptedBlock.length; index += 1) {
    if (decryptedBlock[index] === 0x00) {
      separatorIndex = index;
      break;
    }
  }
  if (separatorIndex < 10) {
    throw new Error('Invalid PKCS#1 padding length');
  }

  return decryptedBlock.subarray(separatorIndex + 1);
}

/**
 * @hidden
 */
export default class AesConnection implements DeviceConnection {
  private readonly queue = new Queue(1, Infinity);

  private readonly credentials?: Credentials;

  private readonly credentialsHash?: string;

  private session?: AesEncryptionSession;

  private sessionCookie?: string;

  private sessionExpiresAt = 0;

  private token?: string;

  constructor(
    public host: string,
    public port: number,
    readonly log: Logger,
    readonly client: Client,
    credentialOptions?: CredentialOptions,
  ) {
    const normalizedCredentials = normalizeCredentialOptions(
      credentialOptions,
      'aes connection credentials',
    );
    this.credentials = normalizedCredentials.credentials;
    this.credentialsHash = normalizedCredentials.credentialsHash;
  }

  private get description(): string {
    return `AES ${this.host}:${this.port}`;
  }

  private resetSession(): void {
    this.session = undefined;
    this.sessionCookie = undefined;
    this.sessionExpiresAt = 0;
    this.token = undefined;
  }

  private isSessionExpired(): boolean {
    return this.sessionExpiresAt === 0 || Date.now() >= this.sessionExpiresAt;
  }

  private static hashLoginCredentials(
    loginV2: boolean,
    credentials: Credentials,
  ): AesLoginParams {
    const username = base64EncodeString(sha1Hex(credentials.username));
    if (loginV2) {
      return {
        username,
        password2: base64EncodeString(sha1Hex(credentials.password)),
      };
    }
    return {
      username,
      password: base64EncodeString(credentials.password),
    };
  }

  private static parseCredentialsHash(credentialsHash: string): AesLoginParams {
    let decoded: string;
    try {
      decoded = Buffer.from(credentialsHash, 'base64').toString('utf8');
    } catch {
      throw new TypeError(
        'credentialsHash must be base64-encoded AES login params JSON for aes transport',
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(decoded);
    } catch {
      throw new TypeError(
        'credentialsHash must be base64-encoded AES login params JSON for aes transport',
      );
    }
    if (!isObjectLike(parsed) || typeof parsed.username !== 'string') {
      throw new TypeError(
        'credentialsHash decoded AES login params must include username',
      );
    }
    if (
      typeof parsed.password !== 'string' &&
      typeof parsed.password2 !== 'string'
    ) {
      throw new TypeError(
        'credentialsHash decoded AES login params must include password or password2',
      );
    }
    return {
      username: parsed.username,
      ...(typeof parsed.password === 'string'
        ? { password: parsed.password }
        : {}),
      ...(typeof parsed.password2 === 'string'
        ? { password2: parsed.password2 }
        : {}),
    };
  }

  private buildLoginCandidates(): AesLoginCandidate[] {
    const candidates: AesLoginCandidate[] = [];
    const seen = new Set<string>();
    const addCandidate = (label: string, params: AesLoginParams): void => {
      const key = JSON.stringify(params);
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push({ label, params });
      }
    };

    if (this.credentialsHash !== undefined) {
      addCandidate(
        'credentialsHash',
        AesConnection.parseCredentialsHash(this.credentialsHash),
      );
    }

    if (this.credentials != null) {
      addCandidate(
        'credentials-v2',
        AesConnection.hashLoginCredentials(true, this.credentials),
      );
      addCandidate(
        'credentials-v1',
        AesConnection.hashLoginCredentials(false, this.credentials),
      );
    }

    const defaultTapoCredentials: Credentials = {
      username: decodeBase64(DEFAULT_TAPO_CREDENTIAL_BASE64.username),
      password: decodeBase64(DEFAULT_TAPO_CREDENTIAL_BASE64.password),
    };
    addCandidate(
      'default-tapo-v2',
      AesConnection.hashLoginCredentials(true, defaultTapoCredentials),
    );
    addCandidate(
      'default-tapo-v1',
      AesConnection.hashLoginCredentials(false, defaultTapoCredentials),
    );

    return candidates;
  }

  private static extractErrorCode(error: unknown): number | undefined {
    if (
      typeof error === 'object' &&
      error !== null &&
      'errorCode' in error &&
      typeof (error as AesStatusError).errorCode === 'number'
    ) {
      return (error as AesStatusError).errorCode;
    }
    return undefined;
  }

  private static extractStatusCode(error: unknown): number | undefined {
    if (
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof (error as AesStatusError).statusCode === 'number'
    ) {
      return (error as AesStatusError).statusCode;
    }
    return undefined;
  }

  private assertResponseSuccess(
    response: unknown,
    context: string,
  ): Record<string, unknown> {
    if (!isObjectLike(response) || typeof response.error_code !== 'number') {
      throw new Error(
        `AesConnection(${this.description}): unexpected ${context} response`,
      );
    }

    if (response.error_code !== 0) {
      const error: AesStatusError = new Error(
        `AesConnection(${this.description}): ${context} failed with error_code ${response.error_code}`,
      );
      error.errorCode = response.error_code;
      if (AES_AUTH_ERROR_CODES.has(response.error_code)) {
        this.resetSession();
      }
      throw error;
    }
    return response;
  }

  private async performHandshake(timeout: number): Promise<void> {
    this.resetSession();

    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 1024,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const handshakeResponse = await this.post(
      AES_PROTOCOL_PATH,
      JSON.stringify({
        method: 'handshake',
        params: { key: publicKey },
      }),
      timeout,
      {
        headers: {
          requestByApp: 'true',
          Accept: 'application/json',
        },
      },
    );

    if (handshakeResponse.statusCode !== 200) {
      throw new Error(
        `AesConnection(${this.description}): handshake failed with status ${handshakeResponse.statusCode}`,
      );
    }

    const parsedResponse: unknown = JSON.parse(handshakeResponse.body);
    const handshakeResult = this.assertResponseSuccess(
      parsedResponse,
      'handshake',
    );
    if (
      !isObjectLike(handshakeResult.result) ||
      typeof handshakeResult.result.key !== 'string'
    ) {
      throw new Error(
        `AesConnection(${this.description}): handshake response is invalid`,
      );
    }

    const unpaddedKeyMaterial = decryptPkcs1v15(
      privateKey,
      Buffer.from(handshakeResult.result.key, 'base64'),
    );
    if (unpaddedKeyMaterial.length < 32) {
      throw new Error(
        `AesConnection(${this.description}): handshake key material is invalid`,
      );
    }

    this.session = {
      key: unpaddedKeyMaterial.subarray(0, 16),
      iv: unpaddedKeyMaterial.subarray(16, 32),
    };

    const setCookies = parseSetCookie(handshakeResponse.headers);
    const timeoutCookie = getCookieValue(setCookies, TIMEOUT_COOKIE_NAME);
    const timeoutSeconds =
      timeoutCookie !== undefined
        ? parseInt(timeoutCookie, 10)
        : ONE_DAY_SECONDS;
    const sessionId =
      getCookieValue(setCookies, SESSION_COOKIE_NAME) ??
      getCookieValue(setCookies, SESSION_COOKIE_NAME_FALLBACK);
    this.sessionCookie =
      sessionId !== undefined
        ? `${SESSION_COOKIE_NAME}=${sessionId}`
        : undefined;

    const adjustedSessionSeconds = Math.max(
      1,
      (Number.isNaN(timeoutSeconds) ? ONE_DAY_SECONDS : timeoutSeconds) -
        SESSION_EXPIRE_BUFFER_SECONDS,
    );
    this.sessionExpiresAt = Date.now() + adjustedSessionSeconds * 1000;
  }

  private async tryLogin(
    loginParams: AesLoginParams,
    timeout: number,
  ): Promise<void> {
    const loginResponse = await this.sendSecurePassthrough(
      JSON.stringify({
        method: 'login_device',
        params: loginParams,
        request_time_milis: Date.now(),
      }),
      timeout,
    );

    const loginResult = this.assertResponseSuccess(loginResponse, 'login');
    if (
      !isObjectLike(loginResult.result) ||
      typeof loginResult.result.token !== 'string'
    ) {
      throw new Error(
        `AesConnection(${this.description}): login response missing token`,
      );
    }
    this.token = loginResult.result.token;
  }

  private async performLogin(timeout: number): Promise<void> {
    const loginCandidates = this.buildLoginCandidates();
    if (loginCandidates.length === 0) {
      throw new Error(
        `AesConnection(${this.description}): no login candidates available`,
      );
    }

    await this.performLoginForCandidate(loginCandidates, timeout, 0);
  }

  private async performLoginForCandidate(
    candidates: AesLoginCandidate[],
    timeout: number,
    index: number,
  ): Promise<void> {
    const candidate = candidates[index];
    if (candidate === undefined) {
      throw new Error(
        `AesConnection(${this.description}): no login candidates succeeded`,
      );
    }

    try {
      await this.tryLogin(candidate.params, timeout);
      this.log.debug(
        'AesConnection(%s): authenticated with %s',
        this.description,
        candidate.label,
      );
    } catch (error) {
      const errorCode = AesConnection.extractErrorCode(error);
      if (
        errorCode !== undefined &&
        AES_AUTH_ERROR_CODES.has(errorCode) &&
        index < candidates.length - 1
      ) {
        await this.performHandshake(timeout);
        await this.performLoginForCandidate(candidates, timeout, index + 1);
      }
      throw error;
    }
  }

  private async ensureSession(timeout: number): Promise<void> {
    if (
      this.session !== undefined &&
      this.token !== undefined &&
      !this.isSessionExpired()
    ) {
      return;
    }

    await this.performHandshake(timeout);
    await this.performLogin(timeout);
  }

  private async sendSecurePassthrough(
    payload: string,
    timeout: number,
  ): Promise<unknown> {
    if (this.session === undefined) {
      throw new Error(
        `AesConnection(${this.description}): session is not initialized`,
      );
    }

    const encryptedPayload = encryptAesPayload(this.session, payload);
    const path =
      this.token !== undefined
        ? `${AES_PROTOCOL_PATH}?token=${encodeURIComponent(this.token)}`
        : AES_PROTOCOL_PATH;

    const response = await this.post(
      path,
      JSON.stringify({
        method: 'securePassthrough',
        params: { request: encryptedPayload },
      }),
      timeout,
      {
        headers: {
          requestByApp: 'true',
          Accept: 'application/json',
        },
        cookie: this.sessionCookie,
      },
    );

    if (response.statusCode === 403) {
      const error: AesStatusError = new Error(
        `AesConnection(${this.description}): request rejected with 403`,
      );
      error.statusCode = 403;
      this.resetSession();
      throw error;
    }
    if (response.statusCode !== 200) {
      throw new Error(
        `AesConnection(${this.description}): request failed with status ${response.statusCode}`,
      );
    }

    const parsedResponse: unknown = JSON.parse(response.body);
    const passthroughResponse = this.assertResponseSuccess(
      parsedResponse,
      'securePassthrough',
    );
    if (
      !isObjectLike(passthroughResponse.result) ||
      typeof passthroughResponse.result.response !== 'string'
    ) {
      throw new Error(
        `AesConnection(${this.description}): securePassthrough response payload is invalid`,
      );
    }

    try {
      const decryptedResponse = decryptAesPayload(
        this.session,
        passthroughResponse.result.response,
      );
      const parsed: unknown = JSON.parse(decryptedResponse);
      return parsed;
    } catch {
      const parsed: unknown = JSON.parse(passthroughResponse.result.response);
      return parsed;
    }
  }

  private isHttpsRequest(): boolean {
    return this.port === 443 || this.port === 4433;
  }

  private async post(
    path: string,
    data: string,
    timeout: number,
    options: AesRequestOptions = {},
  ): Promise<AesHttpResponse> {
    const body = Buffer.from(data, 'utf8');
    const headers: Record<string, string | number> = {
      'Content-Type': 'application/json',
      'Content-Length': body.length,
      Connection: 'keep-alive',
      ...options.headers,
    };
    if (options.cookie !== undefined) {
      headers.Cookie = options.cookie;
    }

    return new Promise((resolve, reject) => {
      const requestOptions: https.RequestOptions = {
        host: this.host,
        port: this.port,
        method: 'POST',
        path,
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
              body: Buffer.concat(chunks).toString('utf8'),
              headers: response.headers,
            });
          });
        },
      );

      request.setTimeout(timeout, () => {
        request.destroy(
          new Error(
            `AesConnection(${this.description}): timeout after ${timeout}ms`,
          ),
        );
      });

      request.on('error', (error) => {
        reject(error);
      });

      request.write(body);
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

    return this.queue.add(() => this.sendWithRetry(payload, timeout, 0));
  }

  private async sendWithRetry(
    payload: string,
    timeout: number,
    attempt: number,
  ): Promise<string> {
    try {
      await this.ensureSession(timeout);
      const response = await this.sendSecurePassthrough(payload, timeout);
      return JSON.stringify(response);
    } catch (error) {
      const statusCode = AesConnection.extractStatusCode(error);
      const errorCode = AesConnection.extractErrorCode(error);
      if (
        attempt === 0 &&
        (statusCode === 403 ||
          (errorCode !== undefined && AES_AUTH_ERROR_CODES.has(errorCode)))
      ) {
        this.resetSession();
        return this.sendWithRetry(payload, timeout, 1);
      }
      throw error;
    }
  }

  close(): void {
    this.resetSession();
  }
}
