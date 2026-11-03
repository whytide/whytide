import { connect } from "node:net";

export const local = (url: string) => [fetch(url), connect(80, "127.0.0.1")];
