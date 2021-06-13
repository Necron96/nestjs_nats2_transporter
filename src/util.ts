import { Observable } from 'rxjs';

// функция для преобразования асинхронного итератора в stream RxJS
export function asyncToObservable(iterable) {
  // возвращаем новый stream
  return new Observable(
    (observer) =>
      void (async () => {
        try {
          for await (const item of iterable) {
            // выход их функции если нет подписчиков на stream
            if (observer.closed) return;
            // передача следующего элемента
            observer.next(item);
          }
          // оповещение о завершении
          observer.complete();
        } catch (e) {
          // передача ошибки
          observer.error(e);
        }
      })(),
  );
}

// функция для получения ключа enum по значению
// нужна для более простой передачи ошибок от Nats в контроллеры
export function getEnumKeyByEnumValue(
  myEnum: any,
  enumValue: number | string,
): string {
  const keys = Object.keys(myEnum).filter((x) => myEnum[x] == enumValue);
  return keys.length > 0 ? keys[0] : '';
}
