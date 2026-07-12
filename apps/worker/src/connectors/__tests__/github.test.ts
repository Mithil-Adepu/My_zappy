import { describe, it, expect } from 'vitest';
import { githubCreateIssueAdapter } from '../github/actions/create-issue';

describe('GitHub create-issue adapter — contract tests', () => {
  const creds = { type: 'api_key' as const, apiKey: 'ghp_test_token', apiSecret: null };
  const idempotencyKey = 'test-key-123';

  describe('buildRequest', () => {
    it('builds correct URL and method', () => {
      const req = githubCreateIssueAdapter.buildRequest({ owner: 'foo', repo: 'bar', title: 'hello' }, creds, idempotencyKey);
      expect(req.url).toBe('https://api.github.com/repos/foo/bar/issues');
      expect(req.method).toBe('POST');
    });

    it('sets Bearer authorization header', () => {
      const req = githubCreateIssueAdapter.buildRequest({ owner: 'foo', repo: 'bar', title: 'hello' }, creds, idempotencyKey);
      expect(req.headers.Authorization).toBe('Bearer ghp_test_token');
      expect(req.headers['Accept']).toBe('application/vnd.github.v3+json');
    });

    it('sets title and body in request body', () => {
      const req = githubCreateIssueAdapter.buildRequest({ owner: 'foo', repo: 'bar', title: 'hello', body: 'world' }, creds, idempotencyKey);
      expect(req.body?.title).toBe('hello');
      expect(req.body?.body).toBe('world');
    });

    it('throws for non-api_key credentials', () => {
      const badCreds = { type: 'oauth' as const, accessToken: 'x', refreshToken: '' };
      expect(() => githubCreateIssueAdapter.buildRequest({ owner: 'foo', repo: 'bar' }, badCreds, '')).toThrow('GitHub requires a Personal Access Token');
    });

    it('throws if owner or repo is missing', () => {
      expect(() => githubCreateIssueAdapter.buildRequest({ title: 'hello' }, creds, '')).toThrow('Owner and Repo are required for GitHub Create Issue');
    });
  });

  describe('parseResponse', () => {
    it('returns completed for successful issue creation', () => {
      const result = githubCreateIssueAdapter.parseResponse({ html_url: 'https://github.com/foo/bar/issues/1', number: 1 });
      expect(result.status).toBe('completed');
      expect(result.output?.issue_number).toBe(1);
      expect(result.output?.issue_url).toBe('https://github.com/foo/bar/issues/1');
    });

    it('returns failed for error response', () => {
      const result = githubCreateIssueAdapter.parseResponse({ message: 'Not Found' });
      expect(result.status).toBe('failed');
      expect(result.errorCode).toBe('GITHUB_API_ERROR');
      expect(result.errorMessage).toBe('Not Found');
    });

    it('has fallback error message for unknown errors', () => {
      const result = githubCreateIssueAdapter.parseResponse({});
      expect(result.errorMessage).toBe('Unknown GitHub error');
    });
  });

  it('supportsIdempotencyKey is false', () => {
    expect(githubCreateIssueAdapter.supportsIdempotencyKey).toBe(false);
  });
});
