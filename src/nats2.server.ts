import { NO_MESSAGE_HANDLER } from '@nestjs/microservices/constants';
import {
  CustomTransportStrategy,
  IncomingRequest,
  Server,
  Transport,
} from '@nestjs/microservices';
import { Observable } from 'rxjs';
import { isUndefined } from '@nestjs/common/utils/shared.utils';
import { Nats2Options } from './nats2.options';
import { connect, Events, NatsConnection, Msg, Status } from 'nats';
import { Nats2JSONSerializer } from './nats2.serializer';
import { Nats2JSONRequestDeserializer } from './nats2.request.deserializer';
import { asyncToObservable } from './util';
import { Nats2Context } from './nats2.context';

// Кастомный "Server" для взаимодействия с Nats 2.0
export class ServerNatsSecond
  extends Server
  implements CustomTransportStrategy
{
  public readonly transportId = Transport.NATS;

  private natsClient: NatsConnection;

  // конструктор
  constructor(private readonly options: Nats2Options['options']) {
    super();

    // инициализируем сериализатор и десериализатор
    // (могут быть заданы в свойствах, поэтому их и передаём)
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
      new Nats2JSONRequestDeserializer(options && options.natsCodec);
  }

  // ключевая функция с которой всё начинается
  // реализация требуется CustomTransportStrategy
  public async listen(
    callback: (err?: unknown, ...optionalParams: unknown[]) => void,
  ) {
    // создание или получение клиента Nats
    this.natsClient = await this.createNatsClient();

    // дополнительный шаг для обработки ошибок
    this.handleError(this.natsClient);
    // привязываем полученный callback
    this.start(callback);
  }

  // метод для создания клиента Nats
  public createNatsClient(): Promise<NatsConnection> {
    // получаем опции или создаём пустой объект с пустыми полями
    const options = this.options || ({} as Nats2Options['options']);
    return connect({
      ...options,
    });
  }

  // условный запуск
  public start(callback?: () => void) {
    // привязываем обработку событий
    this.bindEvents(this.natsClient);

    // вызывать любой предоставленный пользователем обратный вызов из вызова `app.listen ()`
    callback();
  }

  // метод для привязки обработчиков
  public bindEvents(client: NatsConnection) {
    // проверяем указано ли в опциях слушать определённую группу очередей Nats
    const queue = this.getOptionsProp(this.options, 'queue');
    // создаём фабрику для подписки на каналы
    // в зависимости от наличия свойства queue разные фабрики
    const subscribeIntoChannel = queue
      ? (channel: string) => {
          const sub = client.subscribe(channel, { queue });
          asyncToObservable(sub).subscribe((m) =>
            this.getMessageHandler(channel).bind(this)(m),
          );
        }
      : (channel: string) => {
          const sub = client.subscribe(channel);
          asyncToObservable(sub).subscribe((m) =>
            this.getMessageHandler(channel).bind(this)(m),
          );
        };

    // получаем список ключей обработчиков сообщений
    // messageHandlers - заполняется Фреймворком
    // `pattern` -> `handler` key/value pairs
    // handler - получаем из Controller-а
    const registeredPatterns = [...this.messageHandlers.keys()];
    // через цикл осуществляем подписку
    registeredPatterns.forEach((channel) => subscribeIntoChannel(channel));
  }

  // метод для закрытия клиента
  public close() {
    this.natsClient && this.natsClient.close();
    this.natsClient = null;
  }

  // метод для получения обработчика сообщений
  // eslint-disable-next-line @typescript-eslint/ban-types
  public getMessageHandler(channel: string): Function {
    return async (message: Msg) => this.handleMessage(channel, message);
  }

  // обработка сообщений
  public async handleMessage(channel: string, natsMessage: Msg) {
    // создаём контекст Nats
    const natsCtx = new Nats2Context([
      natsMessage.subject,
      natsMessage.headers,
    ]);

    // десериализуем сообщение
    const message = this.deserializer.deserialize(natsMessage.data, {
      channel,
      reply: natsMessage.reply,
    });

    // если в сообщении нет id - значит мы обрабатываем не сообщение а событие
    if (isUndefined((message as IncomingRequest).id)) {
      return this.handleEvent(channel, message, natsCtx);
    }

    // получаем Publisher
    const publish = this.getPublisher(
      natsMessage,
      (message as IncomingRequest).id,
    );

    // получаем обработчик для текущего канала
    const handler = this.getHandlerByPattern(channel);

    // если нет обработчика
    if (!handler) {
      // устанавливаем статус ошибки
      const status = 'error';
      // формируем сообщение что нет обработчика
      const noHandlerPacket = {
        id: (message as IncomingRequest).id,
        status,
        err: NO_MESSAGE_HANDLER,
      };
      // публикуем
      return publish(noHandlerPacket);
    }

    // используем унаследованный метод для преобразования ответа в Observable
    const response$ = this.transformToObservable(
      await handler(message.data, natsCtx),
    ) as Observable<any>;

    // делегируем фреймворку отправку ответа
    response$ && this.send(response$, publish);
  }

  // метод для получения Publisher-а
  public getPublisher(natsMessage, id: string) {
    // если replyTo не пусто
    if (natsMessage.reply) {
      // возвращаем функцию
      return (response: any) => {
        // добавляем свойство id
        Object.assign(response, { id });
        // сереализуем ответ
        const outgoingResponse = this.serializer.serialize(response);
        // публикуем
        return natsMessage.respond(outgoingResponse);
      };
    }

    // Если не указано поле reply - значит некому отвечать, а значит возвращаем
    // пустую функцию
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    return () => {};
  }

  // привязка обработки ошибок
  public handleError(stream: any) {
    // создаём и сразу запускаем вывод в лог ошибки

    // Nats2 предоставляет ассинхронный итератор status, который возвращает оповещения
    // у оповещений следующий интерфейс {type: string, data?: string|ServersChanged}
    asyncToObservable(stream.status()).subscribe((s: Status) => {
      if (s.type === Events.Error) this.logger.error(s.data);
    });
  }
}
