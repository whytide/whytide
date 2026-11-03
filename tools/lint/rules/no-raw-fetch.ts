import ts from "typescript";
import { isAdapterFolder, isIn, isPackageOf, isTestCode } from "../paths.ts";
import type { Finding, ImportRef, Rule } from "../rule.ts";
import { finding, isWrapper, unwrap } from "../rule.ts";

/**
 * Node's network modules, the internal ones Node still loads, and DNS, whose queries leave the
 * machine too: outside the egress client and the adapters, only their server side is used.
 */
const NODE_MODULES = new Set([
  "_http_agent",
  "_http_client",
  "_tls_wrap",
  "dgram",
  "dns",
  "dns/promises",
  "http",
  "http2",
  "https",
  "net",
  "tls",
]);
/** What a local server takes from them; every other value (get, request, connect, Agent, Socket, createSocket…) can send. */
const SERVER_NAMES = new Set(["createSecureServer", "createServer", "Server"]);
/** Not exhaustive: a new client package also meets the dependency review, one package per merge request. */
const CLIENT_PACKAGES = [
  "axios",
  "cross-fetch",
  "follow-redirects",
  "got",
  "isomorphic-fetch",
  "ky",
  "needle",
  "node-fetch",
  "ofetch",
  "superagent",
  "undici",
  "ws",
];
const GLOBALS = new Set(["fetch", "WebSocket"]);
const GLOBAL_OBJECTS = new Set(["global", "globalThis", "self", "window"]);
const DIRECT =
  "only the egress client (core/packages/platform/http) and the adapters reach the network directly";
const DATA =
  "a data: URL module is refused in every file, tests and adapters included: its code can import any built-in or file: URL past the lint";
/** The kinds whose `name` declares something or names a member, rather than reading a variable. */
const NAMING = new Set([
  ts.SyntaxKind.BindingElement,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.ClassExpression,
  ts.SyntaxKind.EnumMember,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.ImportClause,
  ts.SyntaxKind.ImportSpecifier,
  ts.SyntaxKind.JsxAttribute,
  ts.SyntaxKind.MetaProperty,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.MethodSignature,
  ts.SyntaxKind.NamespaceExport,
  ts.SyntaxKind.NamespaceImport,
  ts.SyntaxKind.Parameter,
  ts.SyntaxKind.PropertyAccessExpression,
  ts.SyntaxKind.PropertyAssignment,
  ts.SyntaxKind.PropertyDeclaration,
  ts.SyntaxKind.PropertySignature,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.VariableDeclaration,
]);

type Report = (node: ts.Node) => void;

export const rule: Rule = {
  name: "no-raw-fetch",
  protects:
    "only core/packages/platform/http and the adapters reach the network directly: elsewhere no global fetch or WebSocket, no client side of Node's network modules, no request client package; a data: module nowhere",
  check(file) {
    // A data: module is code in a string, free to import any built-in or file: URL: refused everywhere.
    const findings: Finding[] = file.imports
      .filter((ref) => URL.parse(ref.specifier)?.protocol === "data:")
      .map((ref) => finding(file, rule.name, ref.node.getStart(file.source), DATA));
    if (isIn(file.path, "core/packages/platform/http") || isAdapterFolder(file.path))
      return findings;
    // Test code reaches its own servers on 127.0.0.1, and the stack's Mailpit, with fetch and Node's modules.
    const test = isTestCode(file.path);
    const report = (node: ts.Node, message: string) =>
      findings.push(finding(file, rule.name, node.getStart(file.source), message));
    const text = (node: ts.Node) => node.getText(file.source).replace(/\s+/g, " ");
    /** The locals bound to a whole network module, and the module. */
    const modules = new Map<string, string>();
    for (const ref of file.imports) {
      if (CLIENT_PACKAGES.some((pkg) => isPackageOf(ref.specifier, pkg))) {
        report(ref.node, `${ref.specifier} is a request client: ${DIRECT}`);
      } else if (!test && NODE_MODULES.has(ref.specifier.replace(/^node:/, ""))) {
        const client = (node: ts.Node) => report(node, clientMessage(text(node), ref.specifier));
        checkImport(ref, client, (name) => modules.set(name, ref.specifier));
      }
    }
    const visit = (node: ts.Node): void => {
      // Types never run; a class's `extends` does, so it is not a type here.
      if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
      if (ts.isTypeNode(node) && ts.isPartOfTypeNode(node)) return;
      const global = globalReached(node);
      if (global && !(test && global === "fetch")) {
        report(node, `${text(node)} is the global ${global}: ${DIRECT}`);
      }
      if (ts.isIdentifier(node) && isRead(node) && modules.has(node.text)) {
        const specifier = modules.get(node.text) ?? "";
        checkValue(outermost(node), (use) => report(use, clientMessage(text(use), specifier)));
      }
      ts.forEachChild(node, visit);
    };
    visit(file.source);
    return findings;
  },
};

function clientMessage(code: string, specifier: string): string {
  return `${code} uses ${specifier} as a client: ${DIRECT}; elsewhere only createServer, createSecureServer, Server and types are taken from it`;
}

/** An import of a network module: types and server-side names pass; a local bound to the whole module is followed. */
function checkImport(ref: ImportRef, client: Report, follow: (name: string) => void): void {
  const holder = ref.node.parent;
  if (ts.isImportDeclaration(holder)) {
    const clause = holder.importClause;
    if (!clause || clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return;
    if (clause.name) follow(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) follow(bindings.name.text);
    else if (bindings) checkNames(bindings.elements, client);
  } else if (ts.isExportDeclaration(holder)) {
    if (holder.isTypeOnly) return;
    const clause = holder.exportClause;
    if (clause && ts.isNamedExports(clause)) checkNames(clause.elements, client);
    else client(holder);
  } else if (ts.isCallExpression(holder)) {
    checkValue(outermost(holder, true), client, follow);
  }
}

/** Named imports or exports: each one a type or a server-side name. */
function checkNames(
  elements: readonly (ts.ImportSpecifier | ts.ExportSpecifier)[],
  client: Report,
): void {
  for (const element of elements) {
    const name = (element.propertyName ?? element.name).text;
    if (!element.isTypeOnly && !SERVER_NAMES.has(name)) client(element);
  }
}

/**
 * Where a network module's object goes: a server-side member (`http.createServer`) or destructured
 * server-side names pass; a local not exported, when `follow` is given, is followed; anything else,
 * a client member, the module passed or exported whole, is a client.
 */
function checkValue(use: ts.Expression, client: Report, follow?: (name: string) => void): void {
  const parent = use.parent;
  if (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) {
    if (parent.expression === use && SERVER_NAMES.has(memberOf(parent) ?? "")) return;
    client(parent.expression === use ? parent : use);
  } else if (ts.isVariableDeclaration(parent) && ts.isObjectBindingPattern(parent.name)) {
    for (const element of parent.name.elements) {
      if (!SERVER_NAMES.has(memberOf(element) ?? "")) client(element);
    }
  } else if (follow && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    if (ts.getCombinedModifierFlags(parent) & ts.ModifierFlags.Export) client(use);
    else follow(parent.name.text);
  } else {
    client(use);
  }
}

/** The global fetch or WebSocket a node reaches: `fetch`, `globalThis.fetch`, `self["WebSocket"]`, `{ fetch } = globalThis`. */
function globalReached(node: ts.Node): string | undefined {
  let name: string | undefined;
  if (ts.isIdentifier(node)) name = isRead(node) ? node.text : undefined;
  else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    name = isGlobalObject(node.expression) ? memberOf(node) : undefined;
  } else if (ts.isBindingElement(node)) {
    const holder = node.parent.parent;
    const from =
      ts.isVariableDeclaration(holder) || ts.isParameter(holder) ? holder.initializer : undefined;
    name = from && isGlobalObject(from) ? memberOf(node) : undefined;
  }
  return name !== undefined && GLOBALS.has(name) ? name : undefined;
}

function isGlobalObject(node: ts.Expression): boolean {
  const inner = unwrap(node);
  return ts.isIdentifier(inner) && GLOBAL_OBJECTS.has(inner.text);
}

/** The member an access or a destructured element names, when it is written out: `get` in `http.get`, `http["get"]`, `{ get }`. */
function memberOf(
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression | ts.BindingElement,
): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) {
    const key = node.argumentExpression;
    return ts.isStringLiteralLike(key) ? key.text : undefined;
  }
  const key = node.dotDotDotToken ? undefined : (node.propertyName ?? node.name);
  return key && (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) ? key.text : undefined;
}

/** Whether an identifier reads a variable, rather than declaring one or naming a member or a label. */
function isRead(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (ts.isShorthandPropertyAssignment(parent)) return true;
  if (ts.isExportSpecifier(parent)) {
    return !parent.parent.parent.moduleSpecifier && (parent.propertyName ?? parent.name) === id;
  }
  if (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return false;
  if ((ts.isBindingElement(parent) || ts.isImportSpecifier(parent)) && parent.propertyName === id) {
    return false;
  }
  return !(NAMING.has(parent.kind) && (parent as ts.NamedDeclaration).name === id);
}

/** The expression around `node` once its wrappers, and `await` when asked, are stepped over. */
function outermost(node: ts.Expression, awaits = false): ts.Expression {
  let at = node;
  for (;;) {
    const parent = at.parent;
    if (isWrapper(parent) || (awaits && ts.isAwaitExpression(parent))) at = parent;
    else return at;
  }
}
