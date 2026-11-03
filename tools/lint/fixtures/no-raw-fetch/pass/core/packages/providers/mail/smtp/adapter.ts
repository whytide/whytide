import ky from "ky";
export const send = (url: string) => [ky(url), new WebSocket(url)];
