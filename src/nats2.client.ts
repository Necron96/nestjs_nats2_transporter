import {
  ClientProxy,
  PacketId,
  ReadPacket,
  WritePacket,
} from '@nestjs/microservices';
import { map, mergeMap, share, take } from 'rxjs/operators';
import { Logger } from '@nestjs/common';
import { Nats2Options } from './nats2.options';
import {
  connect,
  Events,
  NatsConnection,
  createInbox,
  Status,
  Msg,
  ErrorCode,
} from 'nats';
import { Nats2JSONSerializer } from './nats2.serializer';
import { Nats2JSONResponseDeserializer } from './nats2.response.deserializer';
import { defer, merge, Observable, Observer, throwError as _throw } from 'rxjs';
import { CONNECT_EVENT, ERROR_EVENT } from '@nestjs/microservices/constants';
import { fromPromise } from 'rxjs/internal-compatibility';
import { isNil } from '@nestjs/common/utils/shared.utils';
import { InvalidMessageException } from '@nestjs/microservices/errors/invalid-message.exception';
import { asyncToObservable, getEnumKeyByEnumValue } from './util';

export class ClientNatsSecond extends ClientProxy {
  protected readonly logger = new Logger(ClientProxy.name);
  protected natsClient: NatsConnection;
  // Сохранено в отличии от версии из Nest v8 alpha7
  protected connection: Promise<any>;

  constructor(protected readonly options: Nats2Options['options']) {
    super();

    // ининициализируем сериализатор и десериализатор
    this.initializeSerializer(options);
    this.initializeDeserializer(options);
  }

  protected initializeSerializer(options: Nats2Options['options']) {
    this.serializer =
      (options && options.serializer) ||
      new Nats2JSONSerializer(options && options.natsCodec);
  }

  protected initializeDeserializer(options: Nats2Options['options']) {
    this.deserializer =
      (options && options.deserializer) ||
      new Nats2JSONResponseDeserializer(options && options.natsCodec);
  }

  // отключение клиента
  public close() {
    this.natsClient && this.natsClient.close();
    this.natsClient = null;
    this.connection = null;
  }

  protected connect$(
    instance: any,
    errorEvent = ERROR_EVENT,
    connectEvent = CONNECT_EVENT,
  ): Observable<any> {
    const error$ = asyncToObservable(instance.status()).pipe(
      map((s: Status) => {
        if (s.type === Events.Error) throw new Error(errorEvent);
      }),
    );
    const connect$ = fromPromise(instance.flush());

    return merge(error$, connect$).pipe(take(1));
  }

  // подсоединение к клиенту Nats, если его не существует
  public async connect(): Promise<any> {
    // проверка наличия соединения
    if (this.natsClient) {
      return this.connection;
    }
    // создание клиента
    this.natsClient = await this.createClient();

    // привязываем логирование ошибок
    this.handleError(this.natsClient);

    // преобразуем клиента Nats в Observable, позволяем им делиться и превращаем в промис
    this.connection = await this.connect$(this.natsClient)
      .pipe(share())
      .toPromise();

    return this.connection;
  }

  // метод для создания клиента Nats
  public createClient(): Promise<NatsConnection> {
    // получаем опции или создаём пустой объект с пустыми полями
    const options = this.options || ({} as Nats2Options['options']);
    return connect({
      ...options,
    });
  }

  public handleError(client: NatsConnection) {
    // создаём и сразу запускаем вывод в лог ошибки

    // Nats2 предоставляет ассинхронный итератор status, который возвращает оповещения
    // у оповещений следующий интерфейс {type: string, data?: string|ServersChanged}
    asyncToObservable(client.status()).subscribe((s: Status) => {
      if (s.type === Events.Error) this.logger.error(s.data);
    });
  }

  public send<TResult = any, TInput = any>(
    pattern: any,
    data: TInput,
  ): Observable<TResult> {
    if (isNil(pattern) || isNil(data)) {
      return _throw(new InvalidMessageException());
    }
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    return defer(async () => this.connect()).pipe(
      mergeMap(() => {
        return new Observable((observer: Observer<TResult>) => {
          const callback = this.createObserver(observer);
          return this.publish({ pattern, data }, callback);
        });
      }),
    );
  }

  // обработка публикации сообщения
  protected publish(
    partialPacket: ReadPacket,
    callback: (packet: WritePacket) => any,
    // eslint-disable-next-line @typescript-eslint/ban-types
  ): Function {
    try {
      // Добавляем Id к сообщению
      const packet = this.assignPacketId(partialPacket);
      // нормализуем паттерн (в общем случае может быть объектом)
      const channel = this.normalizePattern(partialPacket.pattern);
      // сериализуем сообщение
      const serializedPacket = this.serializer.serialize(packet);

      // получаем обработчик сообщений
      const subscriptionHandler = this.createSubscriptionHandler(
        packet,
        callback,
      );

      // здесь эмуляция метода request из nats
      // сделано так для возможности отписаться от обработки ответов

      // создаём инбокс (уникальную строку)
      const inbox = createInbox();

      // создаём подписку на инбокс
      const inboxSub = this.natsClient.subscribe(inbox);

      // превращаем подписку из асинхронного итератора в stream RxJS
      // и к добавляем обработчик ответа в качестве слушателя к данному stream-у
      asyncToObservable(inboxSub).subscribe((m) => subscriptionHandler(m));

      // публикуем в Nats в канал сериализованные данные с дополнительным полем
      // reply, в качестве которого указываем созданный inbox
      this.natsClient.publish(channel, serializedPacket as any, {
        reply: inbox,
      });

      return () => inboxSub.unsubscribe();
    } catch (err) {
      callback({ err });
    }
  }

  public createSubscriptionHandler(
    packet: ReadPacket & PacketId,
    callback: (packet: WritePacket) => any,
    // eslint-disable-next-line @typescript-eslint/ban-types
  ): Function {
    return (natsMessage: Msg) => {
      // проверка что получили ответ
      if (natsMessage.headers && natsMessage.headers.hasError) {
        return callback({
          err: getEnumKeyByEnumValue(ErrorCode, natsMessage.headers.code),
          response: undefined,
          isDisposed: true,
        });
      }

      // десериализуем сообщение
      const message = this.deserializer.deserialize(natsMessage.data);

      // проверяем что есть Id и что он равен Id packet
      if (message.id && message.id !== packet.id) {
        return undefined;
      }

      // деструктируем сообщение
      const { err, response, isDisposed } = message;

      // если передана ошибка или сообщения завершены
      if (isDisposed || err) {
        // вызываем callback со свойством что сообщения завершены
        return callback({
          err,
          response,
          isDisposed: true,
        });
      }

      // вызываем callback без завершения
      callback({
        err,
        response,
      });
    };
  }

  // обработка отправки событий
  protected async dispatchEvent(packet: ReadPacket): Promise<any> {
    // нормализуем паттерн (он может быть и объектом в общем случае)
    const pattern = this.normalizePattern(packet.pattern);
    // сериализуем данные
    const serializedPacket = this.serializer.serialize(packet);

    return new Promise<void>((res, rej) => {
      try {
        this.natsClient.publish(pattern, serializedPacket as any);
        res();
      } catch (err) {
        rej(err);
      }
    });
  }
}
