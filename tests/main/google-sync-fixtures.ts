export function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

export function meeting(id: string, title: string, start = "2026-03-08T16:00:00.000Z"): object {
  return {
    id,
    summary: title,
    start: { dateTime: start },
    end: { dateTime: new Date(new Date(start).getTime() + 30 * 60_000).toISOString() },
  };
}

export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => {
    throw new Error("Deferred resolved before initialization");
  };
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

export function serialized(): <T>(operation: () => Promise<T>) => Promise<T> {
  let previous: Promise<unknown> = Promise.resolve();
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const current = previous.then(operation);
    previous = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  };
}
