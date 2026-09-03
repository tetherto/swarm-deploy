declare const Bare: unknown | undefined

declare module 'brittle' {
  /** Value accepted by `t.exception` and `t.execution`. */
  type Thrower = (() => unknown) | Promise<unknown>

  /** Matcher accepted by `t.exception`, compared with `tmatch`. */
  type ExpectedError = Record<string, unknown> | RegExp | (new (...args: never[]) => Error)

  interface TeardownOptions {
    order?: number
    force?: boolean
  }

  /**
   * Comparison assertions infer from `actual` only, so an expectation can
   * never widen the observed type. Union or literal drift in the expectation
   * therefore fails to type-check instead of failing at runtime.
   */
  interface Assert {
    /**
     * Binary comparisons stay byte-wise: `Buffer` is generic over its backing
     * `ArrayBuffer`, and both sides of these assertions legitimately come from
     * different allocators, so they are compared as views.
     */
    is(actual: Uint8Array, expected: Uint8Array, message?: string): void
    is<T>(actual: T, expected: NoInfer<T>, message?: string): void
    not(actual: Uint8Array, expected: Uint8Array, message?: string): void
    not<T>(actual: T, expected: NoInfer<T>, message?: string): void
    alike(actual: Uint8Array, expected: Uint8Array, message?: string): void
    alike<T>(actual: T, expected: NoInfer<T>, message?: string): void
    unlike(actual: Uint8Array, expected: Uint8Array, message?: string): void
    unlike<T>(actual: T, expected: NoInfer<T>, message?: string): void
    ok(value: unknown, message?: string): void
    absent(value: unknown, message?: string): void
    pass(message?: string): void
    fail(message?: string): void
    exception(fn: Thrower, expected?: ExpectedError | string, message?: string): Promise<void>
    execution(fn: Thrower, message?: string): Promise<number>
    teardown(fn: () => unknown, options?: TeardownOptions): void
    end(): void
  }

  interface TestFn {
    (name: string, fn: (t: Assert) => void | Promise<void>): void
    only(name: string, fn: (t: Assert) => void | Promise<void>): void
    skip(name: string, fn: (t: Assert) => void | Promise<void>): void
  }

  const test: TestFn
  export default test
  export { type Assert, type ExpectedError, type TeardownOptions, type Thrower }
}
