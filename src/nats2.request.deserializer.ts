import {
  ConsumerDeserializer,
  IncomingEvent,
  IncomingRequest,
} from '@nestjs/microservices';
import { Codec, JSONCodec } from 'nats';
import { isUndefined } from '@nestjs/common/utils/shared.utils';

// Класс для десериализации сообщений слушателем Nats (Server)
export class Nats2JSONRequestDeserializer implements ConsumerDeserializer {
  private readonly codec;

  constructor(codec?: Codec<unknown>) {
    this.codec = codec ? codec : JSONCodec();
  }

  deserialize(
    value: Uint8Array,
    options?: Record<string, any>,
  ): IncomingRequest | IncomingEvent {
    // декодируем полученное значение
    const decoded = this.codec.decode(value) as IncomingRequest;
    // если сообщение не от микросервиса Nest - пытаемся сматчить со схемой формата
    return this.isExternal(decoded)
      ? this.mapToSchema(decoded, options)
      : decoded;
  }

  // проверка что сообщение от Nest-ового микросервиса
  isExternal(value: any): boolean {
    if (!value) {
      return true;
    }
    return !(
      !isUndefined((value as IncomingRequest).pattern) ||
      !isUndefined((value as IncomingRequest).data)
    );
  }

  mapToSchema(
    value: any,
    options?: Record<string, any>,
  ): IncomingRequest | IncomingEvent {
    if (!options) {
      return {
        pattern: undefined,
        data: undefined,
      };
    }
    return {
      pattern: options.channel,
      data: value,
    };
  }
}
