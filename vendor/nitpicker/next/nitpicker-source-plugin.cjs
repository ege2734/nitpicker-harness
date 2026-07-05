// nitpicker — dev-only Babel plugin: stamp `data-nitpicker-source="path:line:col"` onto every HOST JSX
// element (lowercase tag) so the element picker can report a source location. React 19 removed
// `_debugSource`, so a runtime click can't recover file:line — this build-time attribute is the durable
// fix that "click-to-component" tools moved to. Component JSX (`<Foo/>`) is skipped: the picker's fiber
// walk already yields the component name, and we only need to locate host DOM nodes.
//
// Loaded ONLY in dev via next.config (gated on NODE_ENV), so it never runs during `next build`.
const path = require("node:path");

module.exports = function nitpickerSourcePlugin({ types: t }) {
  return {
    name: "nitpicker-source",
    visitor: {
      JSXOpeningElement(nodePath, state) {
        const nameNode = nodePath.node.name;
        // Only bare host tags: <div>, <button>, <tr>. Skip <Foo/>, <Foo.Bar/>, fragments, namespaces.
        if (!nameNode || nameNode.type !== "JSXIdentifier") return;
        if (!/^[a-z]/.test(nameNode.name)) return;

        const loc = nodePath.node.loc;
        if (!loc || !loc.start) return;

        const attrs = nodePath.node.attributes;
        const already = attrs.some(
          (a) => a.type === "JSXAttribute" && a.name && a.name.name === "data-nitpicker-source",
        );
        if (already) return;

        const filename = state.file.opts.filename || "";
        const root = state.file.opts.root || process.cwd();
        let rel = path.relative(root, filename);
        if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) rel = filename;
        rel = rel.split(path.sep).join("/"); // stable POSIX-style path for the agent

        const value = `${rel}:${loc.start.line}:${loc.start.column + 1}`;
        attrs.push(t.jsxAttribute(t.jsxIdentifier("data-nitpicker-source"), t.stringLiteral(value)));
      },
    },
  };
};
