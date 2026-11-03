export const read = (api: string) => fetch(new URL("api/v1/messages", api));
