declare const Bare: unknown | undefined

declare module 'brittle' {
  interface Assert {
    is(actual: unknown, expected: unknown, message?: string): void
    not(actual: unknown, expected: unknown, message?: string): void
    ok(value: unknown, message?: string): void
    absent(value: unknown, message?: string): void
    end(): void
  }

  interface TestFn {
    (name: string, fn: (t: Assert) => void | Promise<void>): void
    only(name: string, fn: (t: Assert) => void | Promise<void>): void
    skip(name: string, fn: (t: Assert) => void | Promise<void>): void
  }

  const test: TestFn
  export default test
}
