import type { ChatState } from './activityState';

/** Fired with every Session's `ChatState` whenever the live activity changes. */
export const IOS_ACTIVITY_EVENT = 'grove:ios-activity';

let latest: ChatState[] = [];

/** Shares what the Live Activity tracks with in-app views (the tent view on iPhone Duo). */
export function publishActivity(chats: ChatState[]) {
  latest = chats;
  window.dispatchEvent(new CustomEvent(IOS_ACTIVITY_EVENT, { detail: chats }));
}

/** The last state published, for a view that mounts between changes. */
export const currentActivity = () => latest;
