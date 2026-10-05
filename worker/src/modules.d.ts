// wrangler.jsonc "rules": *.jsonc files are imported as plain text.
declare module '*.jsonc' {
  const text: string;
  export default text;
}
