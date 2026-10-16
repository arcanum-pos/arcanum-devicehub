// schema.sql, bundled as text for the self-hosted server (node.ts).
declare module '*.sql' {
  const text: string;
  export default text;
}
