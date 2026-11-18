// The parts of Chrome's extension API this extension calls, declared by
// hand: a dozen functions, where `@types/chrome` would be a dependency of
// thousands of declarations. Each is as developer.chrome.com documents it
// for Manifest V3, with promises.

declare namespace chrome {
  interface Event<Listener> {
    addListener(listener: Listener): void;
  }

  namespace runtime {
    function getManifest(): { version: string; version_name?: string };
    function getURL(path: string): string;
    const onInstalled: Event<() => void>;
    const onStartup: Event<() => void>;
  }

  namespace i18n {
    /** The message of the browser's language, "" when there is none of that name. */
    function getMessage(name: string, substitutions?: string | string[]): string;
  }

  namespace storage {
    const local: {
      get(keys: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  }

  namespace tabs {
    interface Tab {
      id?: number;
      /** The address, of a tab on a host the extension may read; absent for any other. */
      url?: string;
      active: boolean;
      windowId: number;
    }

    function query(info: { active?: boolean; currentWindow?: boolean; windowId?: number }): Promise<Tab[]>;
    function update(tabId: number, properties: { url: string }): Promise<Tab | undefined>;
    function create(properties: { url: string }): Promise<Tab>;
    const onActivated: Event<(info: { tabId: number; windowId: number }) => void>;
    const onUpdated: Event<(tabId: number, change: { url?: string }, tab: Tab) => void>;
  }

  namespace windows {
    function getCurrent(): Promise<{ id?: number }>;
  }

  namespace sidePanel {
    function setPanelBehavior(behavior: { openPanelOnActionClick: boolean }): Promise<void>;
  }
}
