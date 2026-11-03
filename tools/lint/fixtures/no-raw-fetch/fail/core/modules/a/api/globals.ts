export const viaWindow = (url: string) => window.fetch(url);
export const viaSelf = (url: string) => new self.WebSocket(url);
export const viaGlobal = (url: string) => (global as typeof globalThis).fetch(url);
const { fetch: destructured } = globalThis;
export const passed = { fetch, destructured };
export class Socket extends WebSocket {}
export function viaDefault(url: string, { fetch: f } = globalThis) {
  return f(url);
}
