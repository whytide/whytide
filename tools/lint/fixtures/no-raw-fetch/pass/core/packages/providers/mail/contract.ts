import { connect } from "node:net";
export const statusOf = (port: number) => connect(port, "127.0.0.1");
