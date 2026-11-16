// Vite resolves `?url` imports to the file's served URL; the browser tests use them to point the
// VAD at the installed package files.
declare module "*?url" {
  const url: string;
  export default url;
}
