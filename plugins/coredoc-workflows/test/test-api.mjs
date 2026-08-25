const isBun = Boolean(process.versions.bun);
const api = isBun
  ? await import("bun:test")
  : await import("node:test");

function bunContextTest(name, optionsOrFn, maybeFn) {
  const options = typeof optionsOrFn === "function" ? undefined : optionsOrFn;
  const fn = typeof optionsOrFn === "function" ? optionsOrFn : maybeFn;

  const wrapped = async () => {
    const cleanups = [];
    const restores = [];
    const context = {
      after(cleanup) {
        cleanups.push(cleanup);
      },
      mock: {
        method(target, property, replacement) {
          const descriptor = Object.getOwnPropertyDescriptor(target, property);
          Object.defineProperty(target, property, {
            ...descriptor,
            configurable: true,
            writable: true,
            value: replacement,
          });
          restores.push(() => {
            if (descriptor) Object.defineProperty(target, property, descriptor);
            else delete target[property];
          });
          return replacement;
        },
      },
    };

    let failure;
    try {
      await fn(context);
    } catch (error) {
      failure = error;
    }

    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        failure ??= error;
      }
    }
    for (const restore of restores.reverse()) restore();
    if (failure) throw failure;
  };

  return options === undefined
    ? api.test(name, wrapped)
    : api.test(name, options, wrapped);
}

export const test = isBun ? bunContextTest : api.test;
export default test;
