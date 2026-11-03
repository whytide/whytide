import tls from "node:tls";
export const open = () => tls.connect(443, "example.com");
