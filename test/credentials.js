/* eslint-disable no-unused-expressions */

const { expect } = require('./setup');
const {
  normalizeCredentialOptions,
  mergeCredentialOptions,
  redactCredentialOptions,
} = require('../src/credentials');

describe('Credentials', function () {
  describe('.normalizeCredentialOptions()', function () {
    it('should normalize valid credential options', function () {
      const options = normalizeCredentialOptions({
        credentials: { username: 'user@example.com', password: 'secret' },
        credentialsHash: 'hash123',
      });

      expect(options).to.deep.equal({
        credentials: { username: 'user@example.com', password: 'secret' },
        credentialsHash: 'hash123',
      });
    });

    it('should throw for missing password', function () {
      expect(() =>
        normalizeCredentialOptions({
          credentials: { username: 'user@example.com' },
        }),
      ).to.throw(TypeError, 'credentials.password is required');
    });
  });

  describe('.mergeCredentialOptions()', function () {
    it('should use device overrides over client defaults', function () {
      const merged = mergeCredentialOptions(
        {
          credentials: { username: 'client-user', password: 'client-pass' },
          credentialsHash: 'client-hash',
        },
        {
          credentials: { username: 'device-user', password: 'device-pass' },
          credentialsHash: 'device-hash',
        },
      );

      expect(merged).to.deep.equal({
        credentials: { username: 'device-user', password: 'device-pass' },
        credentialsHash: 'device-hash',
      });
    });

    it('should use client defaults when device overrides are absent', function () {
      const merged = mergeCredentialOptions(
        {
          credentials: { username: 'client-user', password: 'client-pass' },
          credentialsHash: 'client-hash',
        },
        undefined,
      );

      expect(merged).to.deep.equal({
        credentials: { username: 'client-user', password: 'client-pass' },
        credentialsHash: 'client-hash',
      });
    });
  });

  describe('.redactCredentialOptions()', function () {
    it('should redact password and credentialsHash', function () {
      const redacted = redactCredentialOptions({
        host: '127.0.0.1',
        credentials: { username: 'user@example.com', password: 'secret' },
        credentialsHash: 'hash123',
      });

      expect(redacted).to.deep.equal({
        host: '127.0.0.1',
        credentials: {
          username: 'user@example.com',
          password: '[REDACTED]',
        },
        credentialsHash: '[REDACTED]',
      });
    });
  });
});

