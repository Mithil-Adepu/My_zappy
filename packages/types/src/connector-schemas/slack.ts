/** Slack connector type schemas */

export interface SlackSendMessageInput {
  channel: string;   // Slack channel ID or name, e.g. #general
  text: string;      // Message text — supports Slack mrkdwn
}

export interface SlackSendMessageOutput {
  ok: boolean;
  ts: string;        // Slack message timestamp (used as message ID)
  channel: string;
}
