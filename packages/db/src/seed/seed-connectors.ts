/**
 * Seed script — populates the connector catalog:
 *   - connectors (Slack, Razorpay)
 *   - available_triggers (Razorpay payment.captured)
 *   - available_actions  (Slack send-message, Razorpay create-payment)
 *
 * Run via: pnpm --filter @zapier-clone/db db:seed
 * Safe to re-run — uses upsert.
 */

import { prisma } from '../client';

async function main() {
  console.log('🌱  Seeding connector catalog...');

  // ─── Slack ────────────────────────────────────────────────────────────────
  await prisma.connector.upsert({
    where: { id: 'slack' },
    update: {},
    create: {
      id: 'slack',
      name: 'Slack',
      imageUrl: 'https://cdn.worldvectorlogo.com/logos/slack-new-logo.svg',
      authType: 'oauth',
      authUrl: 'https://slack.com/oauth/v2/authorize',
      tokenUrl: 'https://slack.com/api/oauth.v2.access',
      scopes: ['chat:write', 'channels:read'],
      supportsIdempotencyKey: false,
    },
  });

  await prisma.availableAction.upsert({
    where: { id: 'slack:send-message' },
    update: {},
    create: {
      id: 'slack:send-message',
      connectorId: 'slack',
      name: 'Send Message',
      inputSchema: {
        type: 'object',
        required: ['channel', 'text'],
        properties: {
          channel: {
            type: 'string',
            title: 'Channel',
            description: 'Slack channel ID or name (e.g. #general)',
          },
          text: {
            type: 'string',
            title: 'Message Text',
            description: 'Message body — supports Slack mrkdwn formatting',
          },
        },
      },
    },
  });

  // ─── Razorpay ─────────────────────────────────────────────────────────────
  await prisma.connector.upsert({
    where: { id: 'razorpay' },
    update: {},
    create: {
      id: 'razorpay',
      name: 'Razorpay',
      imageUrl: 'https://cdn.worldvectorlogo.com/logos/razorpay.svg',
      authType: 'api_key',
      authUrl: null,
      tokenUrl: null,
      scopes: [],
      supportsIdempotencyKey: true,
    },
  });

  await prisma.availableTrigger.upsert({
    where: { id: 'razorpay:payment-captured' },
    update: {},
    create: {
      id: 'razorpay:payment-captured',
      connectorId: 'razorpay',
      name: 'Payment Captured',
      payloadSchema: {
        type: 'object',
        properties: {
          'payload.payment.entity.id': {
            type: 'string',
            title: 'Payment ID',
          },
          'payload.payment.entity.amount': {
            type: 'number',
            title: 'Amount (paise)',
          },
          'payload.payment.entity.currency': {
            type: 'string',
            title: 'Currency',
          },
          'payload.payment.entity.email': {
            type: 'string',
            title: 'Customer Email',
          },
          'payload.payment.entity.contact': {
            type: 'string',
            title: 'Customer Phone',
          },
        },
      },
    },
  });

  await prisma.availableAction.upsert({
    where: { id: 'razorpay:create-payment' },
    update: {},
    create: {
      id: 'razorpay:create-payment',
      connectorId: 'razorpay',
      name: 'Create Payment Link',
      inputSchema: {
        type: 'object',
        required: ['amount', 'currency'],
        properties: {
          amount: {
            type: 'number',
            title: 'Amount (paise)',
            description: 'Amount in smallest currency unit (e.g. 100 = ₹1)',
          },
          currency: {
            type: 'string',
            title: 'Currency',
            description: "3-letter ISO code, e.g. 'INR'",
          },
          description: {
            type: 'string',
            title: 'Description',
          },
        },
      },
    },
  });

  console.log('✅  Seed complete.');
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
