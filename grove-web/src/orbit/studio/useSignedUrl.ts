import { useEffect, useState } from "react";
import { appendHmacToUrl } from "../../api/client";

/** A URL signed for this client (HMAC / device auth), for `<img src>`; null until ready. */
export function useSignedUrl(url: string | null): string | null {
  const [signed, setSigned] = useState<{ url: string; signed: string } | null>(null);
  useEffect(() => {
    if (!url) return;
    let alive = true;
    void appendHmacToUrl(url).then((value) => {
      if (alive) setSigned({ url, signed: value });
    }).catch(() => {
      if (alive) setSigned(null);
    });
    return () => { alive = false; };
  }, [url]);
  return url && signed?.url === url ? signed.signed : null;
}
