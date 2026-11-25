/** The transport's answer when what stands in front of the server wants a new sign-in. */
const SIGN_IN_NEEDED = 511;
export const SIGN_IN_EVENT = 'grove:ios-sign-in-needed';

/** Every request of the page goes through here, whichever client sent it. */
export function watchForSignIn() {
  const send = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const response = await send(...args);
    if (response.status === SIGN_IN_NEEDED) window.dispatchEvent(new Event(SIGN_IN_EVENT));
    return response;
  };
}
