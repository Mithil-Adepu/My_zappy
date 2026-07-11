import { describe, it, expect } from 'vitest';
import { evaluate } from '../filter-evaluator';

const ctx = {
  payload: {
    payment: {
      entity: {
        amount: 5000,
        currency: 'INR',
        status: 'captured',
        notes: { hello: 'world' },
      },
    },
  },
};

describe('filter-evaluator', () => {
  it('eq — passes when field equals value', () => {
    expect(evaluate({ conditions: [{ field: 'payload.payment.entity.currency', operator: 'eq', value: 'INR' }] }, ctx)).toBe(true);
  });

  it('eq — fails when field does not equal value', () => {
    expect(evaluate({ conditions: [{ field: 'payload.payment.entity.currency', operator: 'eq', value: 'USD' }] }, ctx)).toBe(false);
  });

  it('neq — passes when field is different', () => {
    expect(evaluate({ conditions: [{ field: 'payload.payment.entity.currency', operator: 'neq', value: 'USD' }] }, ctx)).toBe(true);
  });

  it('gt — passes when amount > threshold', () => {
    expect(evaluate({ conditions: [{ field: 'payload.payment.entity.amount', operator: 'gt', value: 1000 }] }, ctx)).toBe(true);
  });

  it('gt — fails when amount <= threshold', () => {
    expect(evaluate({ conditions: [{ field: 'payload.payment.entity.amount', operator: 'gt', value: 5000 }] }, ctx)).toBe(false);
  });

  it('gte — passes at equal value', () => {
    expect(evaluate({ conditions: [{ field: 'payload.payment.entity.amount', operator: 'gte', value: 5000 }] }, ctx)).toBe(true);
  });

  it('lt — passes when amount is smaller', () => {
    expect(evaluate({ conditions: [{ field: 'payload.payment.entity.amount', operator: 'lt', value: 10000 }] }, ctx)).toBe(true);
  });

  it('contains — passes when string contains substring', () => {
    expect(evaluate({ conditions: [{ field: 'payload.payment.entity.status', operator: 'contains', value: 'capt' }] }, ctx)).toBe(true);
  });

  it('exists — passes when field is present', () => {
    expect(evaluate({ conditions: [{ field: 'payload.payment.entity.notes', operator: 'exists' }] }, ctx)).toBe(true);
  });

  it('exists — fails for missing field', () => {
    expect(evaluate({ conditions: [{ field: 'payload.payment.entity.missing', operator: 'exists' }] }, ctx)).toBe(false);
  });

  it('AND logic — all must pass', () => {
    expect(evaluate({
      conditions: [
        { field: 'payload.payment.entity.currency', operator: 'eq', value: 'INR' },
        { field: 'payload.payment.entity.amount', operator: 'gt', value: 1000 },
      ],
      logic: 'AND',
    }, ctx)).toBe(true);
  });

  it('AND logic — fails if any condition fails', () => {
    expect(evaluate({
      conditions: [
        { field: 'payload.payment.entity.currency', operator: 'eq', value: 'INR' },
        { field: 'payload.payment.entity.amount', operator: 'gt', value: 100000 },
      ],
      logic: 'AND',
    }, ctx)).toBe(false);
  });

  it('OR logic — passes if any condition passes', () => {
    expect(evaluate({
      conditions: [
        { field: 'payload.payment.entity.currency', operator: 'eq', value: 'USD' },
        { field: 'payload.payment.entity.amount', operator: 'gt', value: 1000 },
      ],
      logic: 'OR',
    }, ctx)).toBe(true);
  });

  it('no conditions — always passes', () => {
    expect(evaluate({ conditions: [] }, ctx)).toBe(true);
  });

  it('missing conditions key — always passes', () => {
    expect(evaluate({}, ctx)).toBe(true);
  });
});
