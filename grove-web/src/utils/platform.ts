/** Set only by the standalone iOS host, before the frontend is evaluated. */
export const isIosClient = typeof window !== 'undefined'
  && (window as Window & { __GROVE_IOS__?: boolean }).__GROVE_IOS__ === true;
