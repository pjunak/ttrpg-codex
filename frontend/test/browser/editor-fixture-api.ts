export interface EditorFixtureApi {
  submissions: unknown[];
  dirty: boolean[];
  mount(value: unknown, route?: string): Promise<void>;
  refresh(value: unknown): Promise<void>;
  complete(): Promise<void>;
  language(locale: string): void;
}

declare global {
  interface Window { editorFixture: EditorFixtureApi }
}
