// Stand-in for Node built-ins (e.g. `fs`) that some Emscripten codecs
// reference in code paths that only run under Node.
const empty = {};
export default empty;
