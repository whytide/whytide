import https from "https";
export const get = (url: string) => https.get(url);
