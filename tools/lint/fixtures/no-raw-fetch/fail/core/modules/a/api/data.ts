import "data:text/javascript,export default 1";
import { createRequire } from "node:module";
export const viaImport = await import(" DATA:text/javascript,export default 2");
export const viaRequire = require("data:text/javascript,module.exports = 3");
export const viaCreateRequire = createRequire(import.meta.url)("data:text/javascript,");
