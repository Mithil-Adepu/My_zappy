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

  // ─── GitHub ───────────────────────────────────────────────────────────────
  await prisma.connector.upsert({
    where: { id: 'github' },
    update: {},
    create: {
      id: 'github',
      name: 'GitHub',
      imageUrl: 'https://cdn.worldvectorlogo.com/logos/github-icon-1.svg',
      authType: 'api_key', // Just using PAT (Personal Access Token) for simplicity
      authUrl: null,
      tokenUrl: null,
      scopes: [],
      supportsIdempotencyKey: false,
    },
  });

  await prisma.availableAction.upsert({
    where: { id: 'github:create-issue' },
    update: {},
    create: {
      id: 'github:create-issue',
      connectorId: 'github',
      name: 'Create Issue',
      inputSchema: {
        type: 'object',
        required: ['owner', 'repo', 'title'],
        properties: {
          owner: { type: 'string', title: 'Repository Owner', description: 'e.g. facebook' },
          repo: { type: 'string', title: 'Repository Name', description: 'e.g. react' },
          title: { type: 'string', title: 'Issue Title', description: 'The title of the issue' },
          body: { type: 'string', title: 'Issue Body', description: 'Markdown body of the issue' },
        },
      },
    },
  });

  // ─── GitHub Triggers (Tier 1 — typed) ────────────────────────────────────
  // payloadSchema fields use dot-notation matching the raw GitHub webhook payload.
  // Template references: {{ref}}, {{pusher.name}}, {{repository.full_name}}, etc.

  await prisma.availableTrigger.upsert({
    where: { id: 'github:push' },
    update: {},
    create: {
      id: 'github:push',
      connectorId: 'github',
      name: 'Push to Branch',
      payloadSchema: {
        type: 'object',
        description: 'Fires when commits are pushed to any branch or tag.',
        properties: {
          ref:                     { type: 'string', title: 'Ref', description: 'Full ref pushed to, e.g. refs/heads/main' },
          before:                  { type: 'string', title: 'Before SHA', description: 'SHA of the commit before the push' },
          after:                   { type: 'string', title: 'After SHA', description: 'SHA of the HEAD commit after the push' },
          'repository.full_name':  { type: 'string', title: 'Repository', description: 'Owner/repo, e.g. acme/backend' },
          'repository.html_url':   { type: 'string', title: 'Repository URL' },
          'pusher.name':           { type: 'string', title: 'Pusher Name', description: 'GitHub username of the person who pushed' },
          'pusher.email':          { type: 'string', title: 'Pusher Email' },
          compare:                 { type: 'string', title: 'Compare URL', description: 'URL showing the diff of this push' },
        },
      },
    },
  });

  await prisma.availableTrigger.upsert({
    where: { id: 'github:pull_request_opened' },
    update: {},
    create: {
      id: 'github:pull_request_opened',
      connectorId: 'github',
      name: 'Pull Request Opened',
      payloadSchema: {
        type: 'object',
        description: 'Fires when a new pull request is opened.',
        properties: {
          'pull_request.number':           { type: 'number',  title: 'PR Number' },
          'pull_request.title':            { type: 'string',  title: 'PR Title' },
          'pull_request.body':             { type: 'string',  title: 'PR Description' },
          'pull_request.html_url':         { type: 'string',  title: 'PR URL' },
          'pull_request.state':            { type: 'string',  title: 'State', description: 'open | closed | merged' },
          'pull_request.draft':            { type: 'boolean', title: 'Is Draft' },
          'pull_request.user.login':       { type: 'string',  title: 'Opened By (Username)' },
          'pull_request.head.ref':         { type: 'string',  title: 'Source Branch' },
          'pull_request.base.ref':         { type: 'string',  title: 'Target Branch' },
          'pull_request.merged':           { type: 'boolean', title: 'Is Merged' },
          'repository.full_name':          { type: 'string',  title: 'Repository' },
        },
      },
    },
  });

  await prisma.availableTrigger.upsert({
    where: { id: 'github:issue_opened' },
    update: {},
    create: {
      id: 'github:issue_opened',
      connectorId: 'github',
      name: 'Issue Opened',
      payloadSchema: {
        type: 'object',
        description: 'Fires when a new issue is opened.',
        properties: {
          'issue.number':       { type: 'number', title: 'Issue Number' },
          'issue.title':        { type: 'string', title: 'Issue Title' },
          'issue.body':         { type: 'string', title: 'Issue Body' },
          'issue.html_url':     { type: 'string', title: 'Issue URL' },
          'issue.state':        { type: 'string', title: 'State', description: 'open | closed' },
          'issue.user.login':   { type: 'string', title: 'Opened By (Username)' },
          'issue.user.avatar_url': { type: 'string', title: 'Opened By (Avatar URL)' },
          'repository.full_name': { type: 'string', title: 'Repository' },
        },
      },
    },
  });

  await prisma.availableTrigger.upsert({
    where: { id: 'github:branch_created' },
    update: {},
    create: {
      id: 'github:branch_created',
      connectorId: 'github',
      name: 'Branch Created',
      payloadSchema: {
        type: 'object',
        description: 'Fires when a new branch is created (ref_type: branch).',
        properties: {
          ref:                    { type: 'string', title: 'Branch Name', description: 'Name of the created branch' },
          ref_type:               { type: 'string', title: 'Ref Type', description: 'Always "branch" for this trigger' },
          master_branch:          { type: 'string', title: 'Default Branch' },
          'repository.full_name': { type: 'string', title: 'Repository' },
          'repository.html_url':  { type: 'string', title: 'Repository URL' },
          'sender.login':         { type: 'string', title: 'Created By (Username)' },
        },
      },
    },
  });

  await prisma.availableTrigger.upsert({
    where: { id: 'github:release_published' },
    update: {},
    create: {
      id: 'github:release_published',
      connectorId: 'github',
      name: 'Release Published',
      payloadSchema: {
        type: 'object',
        description: 'Fires when a release is published.',
        properties: {
          'release.id':            { type: 'number', title: 'Release ID' },
          'release.tag_name':      { type: 'string', title: 'Tag Name', description: 'e.g. v1.4.2' },
          'release.name':          { type: 'string', title: 'Release Name' },
          'release.body':          { type: 'string', title: 'Release Notes' },
          'release.html_url':      { type: 'string', title: 'Release URL' },
          'release.draft':         { type: 'boolean', title: 'Is Draft' },
          'release.prerelease':    { type: 'boolean', title: 'Is Pre-release' },
          'release.author.login':  { type: 'string', title: 'Published By (Username)' },
          'repository.full_name':  { type: 'string', title: 'Repository' },
        },
      },
    },
  });

  // ─── Generic Webhooks Connector (Tier 2 — catch-all) ──────────────────────
  // Not tied to any specific provider. Accepts any webhook payload as-is.
  // Users reference fields by path against the raw JSON body.
  await prisma.connector.upsert({
    where: { id: 'webhooks' },
    update: {},
    create: {
      id: 'webhooks',
      name: 'Webhooks by ZapFlow',
      imageUrl: 'https://cdn.worldvectorlogo.com/logos/webhooks-icon.svg',
      authType: 'api_key', // The "key" here is the webhook secret for HMAC verification
      authUrl: null,
      tokenUrl: null,
      scopes: [],
      supportsIdempotencyKey: false,
    },
  });

  await prisma.availableTrigger.upsert({
    where: { id: 'webhooks:catch_hook' },
    update: {},
    create: {
      id: 'webhooks:catch_hook',
      connectorId: 'webhooks',
      name: 'Catch Hook (Any Webhook)',
      payloadSchema: {
        type: 'object',
        description:
          'Accepts any webhook payload without validation. ' +
          'Use dot-notation paths (e.g. {{data.user.email}}) to reference fields. ' +
          'No field-name guarantees — shape depends entirely on the sending app.',
        properties: {},
        additionalProperties: true,
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
