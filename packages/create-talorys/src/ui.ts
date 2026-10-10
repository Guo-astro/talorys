import * as p from "@clack/prompts";
import { CancelledError } from "./errors";

export interface SelectChoice<T> {
  value: T;
  label: string;
  hint?: string;
}

/** Terminal UI abstraction so the installer can run interactively or be driven by tests. */
export interface Ui {
  readonly interactive: boolean;
  intro(title: string, subtitle?: string): void;
  info(message: string): void;
  warn(message: string): void;
  success(message: string): void;
  note(message: string, title?: string): void;
  outro(message: string): void;
  error(message: string): void;
  /** Runs `fn` with a spinner; prints ✓ / ✗ when it settles. */
  step<T>(title: string, fn: (update: (msg: string) => void) => Promise<T>, done?: (result: T) => string): Promise<T>;
  text(message: string, opts?: { initial?: string; validate?: (v: string) => string | undefined }): Promise<string>;
  password(message: string, validate?: (v: string) => string | undefined): Promise<string>;
  select<T>(message: string, choices: SelectChoice<T>[]): Promise<T>;
  confirm(message: string, initial?: boolean): Promise<boolean>;
}

function unwrap<T>(value: T | symbol): Exclude<T, symbol> {
  if (p.isCancel(value)) throw new CancelledError();
  return value as Exclude<T, symbol>;
}

export class ClackUi implements Ui {
  readonly interactive = !!process.stdin.isTTY && !!process.stdout.isTTY;

  intro(title: string, subtitle?: string) {
    p.intro(title);
    if (subtitle) p.log.message(subtitle);
  }
  info(message: string) {
    p.log.info(message);
  }
  warn(message: string) {
    p.log.warn(message);
  }
  success(message: string) {
    p.log.success(message);
  }
  note(message: string, title?: string) {
    p.note(message, title);
  }
  outro(message: string) {
    p.outro(message);
  }
  error(message: string) {
    p.log.error(message);
  }

  async step<T>(title: string, fn: (update: (msg: string) => void) => Promise<T>, done?: (result: T) => string): Promise<T> {
    if (!this.interactive) {
      process.stdout.write(`… ${title}\n`);
      try {
        const result = await fn((msg) => process.stdout.write(`  ${msg}\n`));
        process.stdout.write(`✓ ${done ? done(result) : title}\n`);
        return result;
      } catch (error) {
        process.stdout.write(`✗ ${title}\n`);
        throw error;
      }
    }
    const s = p.spinner();
    s.start(title);
    try {
      const result = await fn((msg) => s.message(`${title} — ${msg}`));
      s.stop(done ? done(result) : title);
      return result;
    } catch (error) {
      s.error(title);
      throw error;
    }
  }

  async text(message: string, opts: { initial?: string; validate?: (v: string) => string | undefined } = {}) {
    return unwrap(
      await p.text({
        message,
        placeholder: opts.initial,
        defaultValue: opts.initial,
        validate: opts.validate ? (v) => opts.validate!(v ?? opts.initial ?? "") : undefined,
      }),
    );
  }
  async password(message: string, validate?: (v: string) => string | undefined) {
    return unwrap(await p.password({ message, validate: validate ? (v) => validate(v ?? "") : undefined }));
  }
  async select<T>(message: string, choices: SelectChoice<T>[]) {
    return unwrap(await p.select({ message, options: choices as never })) as unknown as T;
  }
  async confirm(message: string, initial = true) {
    return unwrap(await p.confirm({ message, initialValue: initial }));
  }
}
