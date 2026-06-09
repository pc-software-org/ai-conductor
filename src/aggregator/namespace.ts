export const DELIM = '__';

export function encodeName(serverId: string, name: string): string {
  return `${serverId}${DELIM}${name}`;
}

// Split on the FIRST delimiter. serverId never contains '__' (enforced by schema),
// so everything after the first delimiter is the original name verbatim.
export function decodeName(qualified: string): { serverId: string; name: string } {
  const idx = qualified.indexOf(DELIM);
  if (idx === -1) throw new Error(`Not a namespaced name: ${qualified}`);
  return { serverId: qualified.slice(0, idx), name: qualified.slice(idx + DELIM.length) };
}

// Resources are keyed by opaque URI, so we wrap the original URI inside a conductor URI
// that carries the serverId. Stateless and collision-free across servers.
export function encodeUri(serverId: string, uri: string): string {
  const u = new URL('conductor://route/');
  u.searchParams.set('s', serverId);
  u.searchParams.set('u', uri);
  return u.toString();
}

export function decodeUri(qualified: string): { serverId: string; uri: string } {
  const u = new URL(qualified);
  const s = u.searchParams.get('s');
  const orig = u.searchParams.get('u');
  if (!s || orig === null) throw new Error(`Not a namespaced uri: ${qualified}`);
  return { serverId: s, uri: orig };
}
