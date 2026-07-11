import { describe, it, expect } from 'vitest';
import { validateMappedPayload } from '../payload-validator';

const schema = {
  type: 'object',
  required: ['channel', 'text'],
  properties: {
    channel: { type: 'string' },
    text:    { type: 'string' },
    amount:  { type: 'number' },
  },
};

describe('payload-validator', () => {
  it('passes with all required fields present', () => {
    const result = validateMappedPayload({ channel: '#general', text: 'hello' }, schema, []);
    expect(result.success).toBe(true);
  });

  it('fails when required field is missing (no unresolved fields)', () => {
    const result = validateMappedPayload({ channel: '#general' }, schema, []);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('VALIDATION_FAILED');
    expect(result.errorMessage).toContain('text');
  });

  it('passes when required field is null due to unresolved template', () => {
    // "text" was unresolved — became null — validator should allow null for it
    const result = validateMappedPayload({ channel: '#general', text: null }, schema, ['text']);
    expect(result.success).toBe(true);
  });

  it('removes unresolved fields from required — not blocking', () => {
    const result = validateMappedPayload({ channel: '#general' }, schema, ['text']);
    expect(result.success).toBe(true);
  });

  it('passes with no schema (null schema = allow all)', () => {
    const result = validateMappedPayload({ anything: 'goes' }, null, []);
    expect(result.success).toBe(true);
  });

  it('surfaces unresolvedFields in successful result', () => {
    const result = validateMappedPayload({ channel: '#general', text: null }, schema, ['text']);
    expect(result.unresolvedFields).toContain('text');
  });

  it('wrong type for known field fails validation', () => {
    // amount should be a number
    const result = validateMappedPayload({ channel: '#general', text: 'hi', amount: 'not-a-number' }, schema, []);
    // AJV coerceTypes converts string to number if possible — so "500" would pass
    // But a non-numeric string should fail
    const result2 = validateMappedPayload({ channel: '#general', text: 'hi', amount: 'abc' }, schema, []);
    expect(result2.success).toBe(false);
  });
});
