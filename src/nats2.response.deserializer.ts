import { IncomingResponse, ProducerDeserializer } from '@nestjs/microservices';
import { Codec, JSONCodec } from 'nats';
import { isUndefined } from '@nestjs/common/utils/shared.utils';

// Класс для десериализации ответов клиентом подключения
export class Nats2JSONResponseDeserializer implements ProducerDeserializer {
  private readonly codec;

  constructor(codec?: Codec<unknown>) {
    this.codec = codec ? codec : JSONCodec();
  }

  deserialize(
    value: Uint8Array,
    options?: Record<string, any>,
  ): IncomingResponse {
    const decoded = this.codec.decode(value) as IncomingResponse;
    return this.isExternal(decoded) ? this.mapToSchema(decoded) : decoded;
  }

  isExternal(value: any): boolean {
    if (!value) {
      return true;
    }
    return !(
      !isUndefined((value as IncomingResponse).err) ||
      !isUndefined((value as IncomingResponse).response) ||
      !isUndefined((value as IncomingResponse).isDisposed)
    );
  }

  mapToSchema(value: any): IncomingResponse {
    console.log('inside mapToSchema');
    console.log('value', value);
    return {
      id: value && value.id,
      response: value,
      isDisposed: true,
    };
  }
}
