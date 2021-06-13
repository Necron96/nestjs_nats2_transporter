import { Deserializer, Serializer, Transport } from '@nestjs/microservices';
import { Authenticator, Codec, TlsOptions } from 'nats';

export interface Nats2Options {
  transport?: Transport.NATS;
  options?: {
    // свойства от NATS2
    authenticator?: Authenticator;
    debug?: boolean;
    ignoreClusterUpdates?: boolean;
    inboxPrefix?: string;
    maxPingOut?: number;
    maxReconnectAttempts?: number;
    name?: string;
    noEcho?: boolean;
    noRandomize?: boolean;
    pass?: string;
    pedantic?: boolean;
    pingInterval?: number;
    port?: number;
    reconnect?: boolean;
    reconnectDelayHandler?: () => number;
    reconnectJitter?: number;
    reconnectJitterTLS?: number;
    reconnectTimeWait?: number;
    servers?: Array<string> | string;
    timeout?: number;
    tls?: TlsOptions;
    token?: string;
    user?: string;
    verbose?: boolean;
    waitOnFirstConnect?: boolean;

    // свойство позволяет указать к какой группе очередей Nats подключаться
    // https://docs.nats.io/developing-with-nats/tutorials/queues
    queue?: string;
    // дополнительное свойство для указания кастомного кодека Nats
    natsCodec?: Codec<unknown>;
    // необходимо для Nest
    serializer?: Serializer;
    deserializer?: Deserializer;
    [key: string]: any;
  };
}
