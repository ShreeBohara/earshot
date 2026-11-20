// The mishearing simulator's parameters, stated in one place (spec WP3 step 1). They are targets,
// not measurements: WP6 mines real mishearings from AssemblyAI and Groq and can refit them, and a
// refit that would change the confusable set's classes means a new set (confusable.v2), never an
// edit to v1.
//
// The confusable set fixes its class shares itself (spec §4.5) and conditions on what each class
// needs: class B is a mishearing that survived the keyterm bias, class E2 a snap. So these rates
// shape which mishearings a class gets, not how many items it has. WP10's generated debriefs use
// them as they stand.
import type { MishearOp } from "./ops";

export const CHANNEL_VERSION = "channel.v1";

export interface WitnessParams {
  /** The chance a name is misheard at all, before any keyterm bias acts. */
  readonly pMishear: number;
  /** Which rule a mishearing uses, by weight, among the rules that apply to the name. */
  readonly ops: Readonly<Partial<Record<MishearOp, number>>>;
}

export interface BiasedParams extends WitnessParams {
  /**
   * The chance the keyterm bias pulls a name one word away from an in-list spelling (one word
   * near, the rest the same sound) onto that spelling: a new "Copperline Retail" heard as the
   * CRM's "Copperleaf Retail". A third, so the snapped share of new sound-alike names (E2, 4% of
   * the set) is half the unsnapped share (E1, 8%), as the spec's class shares imply.
   */
  readonly pSnap: number;
  /**
   * In-list spellings that sound exactly like what was heard always win, chosen uniformly: with
   * "Kestrel Aero" and "Kestral Aero" both boosted, the stream writes one of them. This is the
   * spec's "spellings from the name's own confusable group".
   */
  readonly sameSoundSnap: true;
  /** Keyterms per session: AssemblyAI's limit, as `apps/web/lib/voice/keyterms.ts` applies it. */
  readonly maxKeyterms: number;
}

export interface ChannelParams {
  readonly version: typeof CHANNEL_VERSION;
  /** The production stream, primed with the session's keyterms. */
  readonly biased: BiasedParams;
  /** The second witness: no keyterms, so it never snaps, and it may change a sound. */
  readonly unbiased: WitnessParams;
}

export const CHANNEL_PARAMS: ChannelParams = {
  version: CHANNEL_VERSION,
  biased: {
    pMishear: 0.35,
    // The biased stream's own mistakes keep each word's sound (or drop a word): what it gets
    // wrong by sound is the snap, above. A name in the keyterm list misheard this way usually
    // snaps straight back to its spelling.
    ops: { homophone: 0.25, vowel: 0.2, consonant: 0.2, split: 0.1, join: 0.05, dropTail: 0.2 },
    pSnap: 1 / 3,
    sameSoundSnap: true,
    maxKeyterms: 100,
  },
  unbiased: {
    pMishear: 0.4,
    // Without keyterms the second witness writes unusual names the common way ("Akme" as
    // "Acme"), and now and then changes a consonant: about 3% of mentions in the confusable
    // set, the false conflicts WP5's θ_d has to tolerate. Much more would leave G1 no room:
    // a sound-changed reading of a CRM name and a new name heard right look the same to the
    // comparison, so each one costs a point of coverage or a point of wrong-account rate.
    ops: {
      commonSpelling: 0.3,
      vowel: 0.25,
      consonant: 0.2,
      soundChange: 0.05,
      split: 0.1,
      join: 0.05,
      dropTail: 0.05,
    },
  },
};
