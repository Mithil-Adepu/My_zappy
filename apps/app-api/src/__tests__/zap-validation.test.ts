import { describe, it, expect } from 'vitest';
import { validateZapSteps } from '../services/zap-validation.service';

describe('validateZapSteps', () => {
  it('throws if steps array is empty', () => {
    expect(() => validateZapSteps([])).toThrow('at least one step');
  });

  it('throws if no trigger step exists', () => {
    expect(() =>
      validateZapSteps([
        { stepType: 'action', position: 0, availableActionId: 'slack:send-message' },
      ]),
    ).toThrow('exactly one trigger');
  });

  it('throws if more than one trigger step', () => {
    expect(() =>
      validateZapSteps([
        { stepType: 'trigger', position: 0, availableTriggerId: 'razorpay:payment.captured' },
        { stepType: 'trigger', position: 1, availableTriggerId: 'github:push' },
      ]),
    ).toThrow('exactly one trigger');
  });

  it('throws if trigger is not at position 0', () => {
    expect(() =>
      validateZapSteps([
        { stepType: 'action', position: 0, availableActionId: 'slack:send-message' },
        { stepType: 'trigger', position: 1, availableTriggerId: 'razorpay:payment.captured' },
      ]),
    ).toThrow('position 0');
  });

  it('throws if positions have gaps', () => {
    expect(() =>
      validateZapSteps([
        { stepType: 'trigger', position: 0, availableTriggerId: 'razorpay:payment.captured' },
        { stepType: 'action', position: 2, availableActionId: 'slack:send-message' }, // gap at 1
      ]),
    ).toThrow('contiguous');
  });

  it('throws if positions are duplicated', () => {
    expect(() =>
      validateZapSteps([
        { stepType: 'trigger', position: 0, availableTriggerId: 'razorpay:payment.captured' },
        { stepType: 'action', position: 0, availableActionId: 'slack:send-message' },
      ]),
    ).toThrow('Duplicate');
  });

  it('throws if trigger has no availableTriggerId', () => {
    expect(() =>
      validateZapSteps([
        { stepType: 'trigger', position: 0 },
      ]),
    ).toThrow('availableTriggerId');
  });

  it('throws if trigger also sets availableActionId', () => {
    expect(() =>
      validateZapSteps([
        {
          stepType: 'trigger',
          position: 0,
          availableTriggerId: 'razorpay:payment.captured',
          availableActionId: 'slack:send-message',
        },
      ]),
    ).toThrow('must not specify availableActionId');
  });

  it('throws if action step has availableTriggerId', () => {
    expect(() =>
      validateZapSteps([
        { stepType: 'trigger', position: 0, availableTriggerId: 'razorpay:payment.captured' },
        {
          stepType: 'action',
          position: 1,
          availableTriggerId: 'razorpay:payment.captured',
          availableActionId: 'slack:send-message',
        },
      ]),
    ).toThrow('must not specify availableTriggerId');
  });

  it('passes valid single-trigger zap', () => {
    expect(() =>
      validateZapSteps([
        { stepType: 'trigger', position: 0, availableTriggerId: 'razorpay:payment.captured' },
      ]),
    ).not.toThrow();
  });

  it('passes valid trigger + action + filter zap', () => {
    expect(() =>
      validateZapSteps([
        { stepType: 'trigger', position: 0, availableTriggerId: 'razorpay:payment.captured' },
        { stepType: 'filter',  position: 1 },
        { stepType: 'action',  position: 2, availableActionId: 'slack:send-message' },
      ]),
    ).not.toThrow();
  });
});
