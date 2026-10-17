/** Loaded only by the standalone offline runner; no SDK constructor can escape. */
export class Daytona {
  constructor() { throw new Error("Live provider construction is unavailable in the offline harness."); }
}
