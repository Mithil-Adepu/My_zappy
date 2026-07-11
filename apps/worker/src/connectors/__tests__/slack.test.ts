import { describe, it, expect } from 'vitest';
import { slackSendMessageAdapter } from '../slack/actions/send-message';

describe('Slack send-message adapter — contract tests', () => {
  const creds = { type: 'oauth' as const, accessToken: 'xoxb-test-token', refreshToken: '' };
  const idempotencyKey = 'test-key-123';

  describe('buildRequest', () => {
    it('builds correct URL and method', () => {
      const req = slackSendMessageAdapter.buildRequest({ channel: '#test', text: 'hello' }, creds, idempotencyKey);
      expect(req.url).toBe('https://slack.com/api/chat.postMessage');
      expect(req.method).toBe('POST');
    });

    it('sets Bearer authorization header', () => {
      const req = slackSendMessageAdapter.buildRequest({ channel: '#test', text: 'hello' }, creds, idempotencyKey);
      expect(req.headers.Authorization).toBe('Bearer xoxb-test-token');
    });

    it('sets channel and text in body', () => {
      const req = slackSendMessageAdapter.buildRequest({ channel: '#general', text: 'hello world' }, creds, idempotencyKey);
      expect(req.body?.channel).toBe('#general');
      expect(req.body?.text).toBe('hello world');
    });

    it('does NOT include idempotency key header (Slack has no such mechanism)', () => {
      const req = slackSendMessageAdapter.buildRequest({ channel: '#test', text: 'hi' }, creds, idempotencyKey);
      expect(req.headers['X-Idempotency-Key']).toBeUndefined();
    });

    it('throws for non-oauth credentials', () => {
      const badCreds = { type: 'api_key' as const, apiKey: 'k', apiSecret: null };
      expect(() => slackSendMessageAdapter.buildRequest({}, badCreds, '')).toThrow('OAuth');
    });
  });

  describe('parseResponse', () => {
    it('returns completed for ok:true response', () => {
      const result = slackSendMessageAdapter.parseResponse({ ok: true, ts: '12345.678', channel: 'C1234' });
      expect(result.status).toBe('completed');
      expect(result.output?.ts).toBe('12345.678');
    });

    it('returns failed for ok:false response', () => {
      const result = slackSendMessageAdapter.parseResponse({ ok: false, error: 'channel_not_found' });
      expect(result.status).toBe('failed');
      expect(result.errorCode).toBe('SLACK_API_ERROR');
      expect(result.errorMessage).toBe('channel_not_found');
    });

    it('has fallback error message for unknown errors', () => {
      const result = slackSendMessageAdapter.parseResponse({ ok: false });
      expect(result.errorMessage).toBe('Unknown Slack error');
    });
  });

  it('supportsIdempotencyKey is false', () => {
    expect(slackSendMessageAdapter.supportsIdempotencyKey).toBe(false);
  });
});
