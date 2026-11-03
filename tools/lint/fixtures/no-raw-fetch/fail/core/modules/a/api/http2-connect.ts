import http2 from "node:http2";
export const open = () => http2.connect("https://example.com");
