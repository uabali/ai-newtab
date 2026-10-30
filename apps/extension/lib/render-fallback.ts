/** The parts of a saved homepage this needs (kept structural so tests needn't load storage). */
interface Version {
  timestamp: string;
  repairAttempted?: boolean;
}

/**
 * What a tab shows when a homepage fails to render, and whether to ask for the
 * one repair. Pure, so it is unit-tested.
 *
 * - The newest homepage failed: show the last version that rendered (if it is a
 *   different one), and request a repair unless this homepage already had its one.
 * - The fallback failed too: show nothing (the page shows an error card, never a
 *   blank screen) and don't ask again.
 */
export function decideOnRenderFailure<H extends Version>(input: {
  current: H;
  /** The version that just failed to render. */
  failed: H;
  lastGood: H | undefined;
  /** False when there is no API key, so a repair can't run. */
  canRepair: boolean;
}): { show: H | null; repair: boolean } {
  const { current, failed, lastGood } = input;
  if (failed.timestamp !== current.timestamp) return { show: null, repair: false };
  const fallback = lastGood && lastGood.timestamp !== current.timestamp ? lastGood : null;
  return { show: fallback, repair: input.canRepair && !current.repairAttempted };
}

/** Worker-side guard: repair exactly once, and only the homepage the tab saw fail. */
export function shouldRepair<H extends Version>(saved: H | undefined, request: { timestamp: string }): saved is H {
  return Boolean(saved && saved.timestamp === request.timestamp && !saved.repairAttempted);
}
