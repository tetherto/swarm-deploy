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

  interface Assert {
    is(actual: unknown, expected: unknown, message?: string): void
    not(actual: unknown, expected: unknown, message?: string): void
    alike(actual: unknown, expected: unknown, message?: string): void
    unlike(actual: unknown, expected: unknown, message?: string): void
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
