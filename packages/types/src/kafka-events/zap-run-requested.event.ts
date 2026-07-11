/** Message published to Kafka topic: zap.run.requested */
export interface ZapRunRequestedEvent {
  webhookEventId: string; // bigint serialized as string for JSON safety
  zapId: string;
  userId: string;
  payload: Record<string, unknown>;
  receivedAt: string; // ISO 8601
}
