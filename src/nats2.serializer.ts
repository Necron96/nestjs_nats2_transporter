// src/common/serializers/outbount-response-identity.serializer.ts
import { Serializer } from '@nestjs/microservices';
import { Codec, JSONCodec } from 'nats';

// класс для сериализации сообщений в Nats
export class Nats2JSONSerializer implements Serializer {
  private readonly codec;

  constructor(codec?: Codec<unknown>) {
    this.codec = codec ? codec : JSONCodec();
  }

  serialize(value: any): Uint8Array {
    return this.codec.encode(value);
  }
}
