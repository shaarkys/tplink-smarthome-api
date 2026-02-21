export interface Credentials {
  username: string;
  password: string;
}

export interface CredentialOptions {
  credentials?: Credentials;
  credentialsHash?: string;
}

const REDACTED = '[REDACTED]';

function assertCredentialPair(
  credentials: Credentials | undefined,
  context: string,
): void {
  if (credentials == null) return;

  if (
    typeof credentials.username !== 'string' ||
    credentials.username.length === 0
  ) {
    throw new TypeError(`${context}: credentials.username is required`);
  }

  if (
    typeof credentials.password !== 'string' ||
    credentials.password.length === 0
  ) {
    throw new TypeError(`${context}: credentials.password is required`);
  }
}

function assertCredentialsHash(
  credentialsHash: string | undefined,
  context: string,
): void {
  if (credentialsHash == null) return;
  if (typeof credentialsHash !== 'string' || credentialsHash.length === 0) {
    throw new TypeError(`${context}: credentialsHash must be a non-empty string`);
  }
}

export function normalizeCredentialOptions(
  options: CredentialOptions | undefined,
  context = 'credential options',
): CredentialOptions {
  const credentials =
    options?.credentials == null
      ? undefined
      : {
          username: options.credentials.username,
          password: options.credentials.password,
        };
  const credentialsHash = options?.credentialsHash;

  assertCredentialPair(credentials, context);
  assertCredentialsHash(credentialsHash, context);

  return { credentials, credentialsHash };
}

export function mergeCredentialOptions(
  clientOptions: CredentialOptions | undefined,
  deviceOptions: CredentialOptions | undefined,
  context = 'device credential options',
): CredentialOptions {
  const clientNormalized = normalizeCredentialOptions(
    clientOptions,
    `${context} (client defaults)`,
  );
  const deviceNormalized = normalizeCredentialOptions(
    deviceOptions,
    `${context} (device overrides)`,
  );

  return {
    credentials: deviceNormalized.credentials ?? clientNormalized.credentials,
    credentialsHash:
      deviceNormalized.credentialsHash ?? clientNormalized.credentialsHash,
  };
}

function isObjectLike(
  candidate: unknown,
): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null;
}

export function redactCredentialOptions<T>(options: T): T {
  if (!isObjectLike(options)) {
    return options;
  }

  const redacted: Record<string, unknown> = { ...options };

  if (
    'credentials' in redacted &&
    typeof redacted.credentials === 'object' &&
    redacted.credentials !== null
  ) {
    const credentials = redacted.credentials as Partial<Credentials>;
    redacted.credentials = {
      ...credentials,
      ...(credentials.password !== undefined ? { password: REDACTED } : {}),
    } as unknown;
  }

  if ('credentialsHash' in redacted && redacted.credentialsHash != null) {
    redacted.credentialsHash = REDACTED;
  }

  return redacted as T;
}
