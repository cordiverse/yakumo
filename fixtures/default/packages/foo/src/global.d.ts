declare module 'jsx-import-source/jsx-runtime' {
  export const jsx: any
  export const jsxs: any
}

namespace JSX {
  interface IntrinsicElements {
    'foo:bar': any
  }
}
