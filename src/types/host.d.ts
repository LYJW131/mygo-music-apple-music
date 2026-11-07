// The host object MyGo Music gives a plugin, as far as this plugin uses it.
// See internal/plugin/host.go in MyGo Music.

export {};

declare global {
  const host: Host;

  interface Host {
    platform: string;
    arch: string;
    dir: string;
    dataDir: string;
    storage: {
      get<T = unknown>(key: string): T | undefined;
      set(key: string, value: unknown): void;
      remove(key: string): void;
    };
    /** The listener's language, `en` or `zh-CN`. */
    language(): string;
    /** The text in the listener's language, from the plugin's locales. */
    t(text: string): string;
    setting(key: string): string;
    openURL(url: string): void;
    removeDataDir(name: string): void;
    /** Missing from versions of MyGo Music that can't show a sign-in page. */
    webSignIn?(options: WebSignIn): Promise<{ cookie: string }>;
    /** A program the process permission names, once the listener allowed it. */
    spawn(command: string, args: string[]): HostProcess;
  }

  interface WebSignIn {
    url: string;
    cookiesOf: string;
    until: string[];
    userAgent?: string;
  }

  interface HostProcess {
    pid: number;
    write(text: string): void;
    closeStdin(): void;
    kill(): void;
    /** The next line of its output, or null once it ended. */
    readLine(): Promise<string | null>;
    /** Its exit code. */
    wait(): Promise<number>;
    /** What it wrote to stderr so far. */
    errorOutput(): string;
  }
}
