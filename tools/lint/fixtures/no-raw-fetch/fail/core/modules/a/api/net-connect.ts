import net from "node:net";
export const open = () => net.connect(443, "example.com");
