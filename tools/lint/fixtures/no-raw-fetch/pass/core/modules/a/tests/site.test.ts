import dgram from "node:dgram";
import { connect } from "node:net";
export const local = (url: string) => [
  fetch(url),
  globalThis.fetch(url),
  connect(80, "127.0.0.1"),
  dgram.createSocket("udp4"),
];
