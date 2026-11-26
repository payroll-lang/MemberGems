'use client';

import { announceAction } from '../actions';
import { BatchRunner } from '../_ui/BatchRunner';

export function Announce() {
  return (
    <BatchRunner
      label="Announce this window"
      confirm="Email every participant with exercisable options (and not blocked or outside the enabled list) that this window is open? Anyone already told is skipped."
      run={(cursor) => announceAction(cursor)}
    />
  );
}
