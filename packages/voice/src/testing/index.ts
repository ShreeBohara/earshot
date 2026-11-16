// `@earshot/voice/testing`: fakes for tests, `pnpm dev` without keys, and the end-to-end eval.
// Never import it from production code; the web app's bundle check fails if FAKE_STT_MARKER
// turns up in a production bundle.
export { FakeCaptureSource } from "./fake-capture";
export { FakeServerSocket, FakeSocketServer, settle } from "./fake-socket";
export {
  createFakeSttAdapter,
  FAKE_STT_MARKER,
  type FakeSttAdapter,
  type FakeSttFaults,
  type FakeSttOptions,
  type FakeSttScript,
  type FakeSttStats,
  type FakeSttTurn,
  type FakeSttWord,
  fakeCredential,
  spreadWords,
} from "./fake-stt";
