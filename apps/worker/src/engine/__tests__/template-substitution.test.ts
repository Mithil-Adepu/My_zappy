import { describe, it, expect } from 'vitest';
import { apply } from '../template-substitution';

describe('template-substitution', () => {
  const ctx = {
    payload: {
      payment: {
        entity: {
          amount: 5000,
          currency: 'INR',
          id: 'pay_abc123',
        },
      },
    },
    step_1: {
      ts: '1234567890.123456',
    },
  };

  it('resolves a single nested token directly (preserves number type)', () => {
    const { mappedPayload, unresolvedFields } = apply({ amount: '{{payload.payment.entity.amount}}' }, ctx);
    expect(mappedPayload.amount).toBe(5000);
    expect(typeof mappedPayload.amount).toBe('number');
    expect(unresolvedFields).toHaveLength(0);
  });

  it('interpolates tokens inside a string', () => {
    const { mappedPayload } = apply(
      { text: 'Payment of {{payload.payment.entity.amount}} {{payload.payment.entity.currency}} received' },
      ctx,
    );
    expect(mappedPayload.text).toBe('Payment of 5000 INR received');
  });

  it('passes through non-string values unchanged', () => {
    const { mappedPayload } = apply({ count: 42, active: true }, ctx);
    expect(mappedPayload.count).toBe(42);
    expect(mappedPayload.active).toBe(true);
  });

  it('returns null for unresolved token (NOT a string placeholder)', () => {
    const { mappedPayload, unresolvedFields } = apply(
      { channel: '{{payload.payment.entity.channel}}' },
      ctx,
    );
    expect(mappedPayload.channel).toBeNull();
    expect(unresolvedFields).toContain('channel');
  });

  it('resolves cross-step references (step_1 output)', () => {
    const { mappedPayload } = apply({ ts: '{{step_1.ts}}' }, ctx);
    expect(mappedPayload.ts).toBe('1234567890.123456');
  });

  it('handles empty config gracefully', () => {
    const { mappedPayload, unresolvedFields } = apply({}, ctx);
    expect(mappedPayload).toEqual({});
    expect(unresolvedFields).toHaveLength(0);
  });

  it('partial resolution in mixed string — field is null when any token is unresolved', () => {
    const { mappedPayload, unresolvedFields } = apply(
      { text: 'id={{payload.payment.entity.id}} ref={{payload.payment.entity.ref}}' },
      ctx,
    );
    // {{ref}} is missing — whole field becomes null, added to unresolvedFields
    expect(mappedPayload.text).toBeNull();
    expect(unresolvedFields).toContain('text');
  });
});
