import { Entry } from '@napi-rs/keyring';

// Native-keychain access behind a narrow interface so the rest of the app (and tests)
// never depend on the native module directly.
//
// All methods are SYNCHRONOUS by contract. SecretResolver.resolve() substitutes tokens
// inside a synchronous String.replace callback, so an async backend cannot be dropped in
// without reworking that loop (collect tokens → Promise.all → substitute). Keep it sync.
export interface KeychainBackend {
  get(name: string): string | null; // null if missing; throws if the OS backend is unavailable
  set(name: string, value: string): void;
  delete(name: string): boolean; // true if an entry was removed
}

export const KEYCHAIN_SERVICE = 'mcp-proxy-conductor';

export function osKeychain(service: string = KEYCHAIN_SERVICE): KeychainBackend {
  return {
    get: (name) => new Entry(service, name).getPassword(),
    set: (name, value) => {
      new Entry(service, name).setPassword(value);
    },
    delete: (name) => new Entry(service, name).deletePassword(),
  };
}
