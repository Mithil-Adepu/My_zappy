import { Kafka, Producer, Partitioners } from 'kafkajs';
import { env } from '../config/env';

let producer: Producer | null = null;
let kafka: Kafka | null = null;

export function getKafka(): Kafka {
  if (!kafka) {
    kafka = new Kafka({
      clientId: env.KAFKA_CLIENT_ID,
      brokers: env.KAFKA_BROKERS.split(','),
      retry: { retries: 5 },
    });
  }
  return kafka;
}

export async function getProducer(): Promise<Producer> {
  if (!producer) {
    producer = getKafka().producer({
      createPartitioner: Partitioners.LegacyPartitioner,
    });
    await producer.connect();
    console.log('✅  Kafka producer connected');
  }
  return producer;
}

export async function disconnectProducer(): Promise<void> {
  if (producer) {
    await producer.disconnect();
    producer = null;
    console.log('Kafka producer disconnected');
  }
}
